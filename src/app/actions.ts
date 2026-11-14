"use server";

import {
  AccountTokenPurpose,
  BookingStatus,
  BusinessStatus,
  NotificationChannel,
  PaymentStatus,
  Prisma,
  ReviewStatus,
  UserRole,
} from "@appointly/prisma-client";
import bcrypt from "bcryptjs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { canCustomerManageBooking, canManageBusiness, canReviewBooking } from "@/lib/authorization";
import { canTransitionBooking, type TimeWindow } from "@/lib/booking-rules";
import { db } from "@/lib/db";
import {
  isFutureLocalAppointment,
  isE164Phone,
  isStrongPassword,
  isValidEmail,
  isValidPhone,
  isValidTimeZone,
  normalizeEmail,
  parseMinuteOfDay,
  parseMoneyToCents,
  sanitizeText,
} from "@/lib/validation";
import { hashSessionToken, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/lib/session";
import {
  createAdminCode,
  createEmailVerification,
  createPhoneVerification,
  hashOneTimeCode,
  hashToken,
  isOneTimeCodeConfigured,
} from "@/lib/account-security";
import { enqueueAccountMessage } from "@/lib/notifications";
import {
  createRazorpayPaymentLink,
  cancelRazorpayPaymentLink,
  isRazorpayConfigured,
  refundRazorpayPayment,
} from "@/lib/integrations";
import { enqueueBookingUpdate } from "@/lib/notifications";
import { getLocalAppointmentInstant } from "@/lib/validation";
import {
  createBookingRequest,
  removeScheduleException as removeScheduleExceptionWorkflow,
  saveAvailability,
  saveScheduleException,
  setAccountActive as updateAccountActive,
  setReviewModeration,
} from "@/lib/workflows";

const SESSION_TTL_MS = SESSION_MAX_AGE_SECONDS * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;
const dummyPasswordHash = bcrypt.hash("invalid-login-dummy-password", 12);

function field(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function formText(formData: FormData, name: string, limit: number) {
  return sanitizeText(field(formData, name), limit);
}

function parseTimeWindows(value: string): TimeWindow[] | null {
  if (!value.trim()) return [];
  const windows: TimeWindow[] = [];
  for (const range of value.split(",")) {
    const [opening, closing, ...extra] = range.trim().split("-");
    const openingMinute = parseMinuteOfDay(opening ?? "");
    const closingMinute = parseMinuteOfDay(closing ?? "");
    if (extra.length || openingMinute === null || closingMinute === null || openingMinute >= closingMinute) return null;
    windows.push({ openingMinute, closingMinute });
  }
  return windows;
}

function parseCoordinate(value: string, minimum: number, maximum: number) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function withMessage(path: string, key: "error" | "message", message: string): never {
  const separator = path.includes("?") ? "&" : "?";
  redirect(`${path}${separator}${key}=${encodeURIComponent(message)}`);
}

function fail(path: string, message: string): never {
  return withMessage(path, "error", message);
}

function message(path: string, value: string): never {
  return withMessage(path, "message", value);
}

function isPrismaCode(error: unknown, code: string) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

async function setSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.deleteMany({ where: { userId, expiresAt: { lte: new Date() } } });
  await db.session.create({ data: { userId, tokenHash: hashSessionToken(token), expiresAt } });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    expires: expiresAt,
  });
}

async function actionUser(roles?: UserRole[]) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session =
    token && token.length <= 200
      ? await db.session.findUnique({
          where: { tokenHash: hashSessionToken(token) },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                role: true,
                active: true,
                emailVerifiedAt: true,
                phoneVerifiedAt: true,
                smsNotificationsEnabled: true,
              },
            },
          },
        })
      : null;

  if (!session || session.expiresAt <= new Date() || !session.user.active) {
    fail("/login", "Please sign in to continue.");
  }
  if (roles && !roles.includes(session.user.role)) fail("/", "You do not have permission to do that.");
  return session.user;
}

async function writeAudit(
  tx: Prisma.TransactionClient,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Prisma.InputJsonValue = {},
) {
  await tx.auditLog.create({ data: { actorId, action, targetType, targetId, metadata } });
}

function loginThrottleKeys(email: string, clientAddress: string) {
  const pair = createHash("sha256").update(`pair:${email}:${clientAddress}`).digest("hex");
  const address = createHash("sha256").update(`address:${clientAddress}`).digest("hex");
  return [pair, address];
}

async function recordLoginFailure(throttleKeys: string[]) {
  const now = new Date();
  for (let retry = 0; ; retry += 1) {
    try {
      await db.$transaction(
        async (tx) => {
          await tx.loginThrottle.deleteMany({
            where: { windowStartedAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
          });
          for (const id of throttleKeys) {
            const throttle = await tx.loginThrottle.findUnique({ where: { id } });
            if (!throttle) {
              await tx.loginThrottle.create({ data: { id, attempts: 1, windowStartedAt: now } });
              continue;
            }
            if (now.getTime() - throttle.windowStartedAt.getTime() >= LOGIN_WINDOW_MS) {
              await tx.loginThrottle.update({
                where: { id },
                data: { attempts: 1, windowStartedAt: now, blockedUntil: null },
              });
              continue;
            }
            const attempts = throttle.attempts + 1;
            await tx.loginThrottle.update({
              where: { id },
              data: {
                attempts,
                blockedUntil: attempts >= MAX_LOGIN_ATTEMPTS ? new Date(now.getTime() + LOGIN_WINDOW_MS) : null,
              },
            });
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return;
    } catch (error) {
      if ((!isPrismaCode(error, "P2034") && !isPrismaCode(error, "P2002")) || retry >= 2) throw error;
    }
  }
}

export async function logoutUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
  cookieStore.delete(SESSION_COOKIE);
  redirect("/");
}

export async function requestEmailVerification() {
  const user = await actionUser();
  if (!user.emailVerifiedAt) {
    const previous = await db.accountToken.findFirst({
      where: { userId: user.id, purpose: AccountTokenPurpose.EMAIL_VERIFICATION },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (previous && Date.now() - previous.createdAt.getTime() < 2 * 60 * 1000) {
      fail("/my-bookings", "Please wait a few minutes before requesting another verification email.");
    }
    await db.$transaction((tx) => createEmailVerification(tx, user));
  }
  message("/my-bookings", user.emailVerifiedAt ? "Your email is already verified." : "Email verification sent if the service is configured.");
}

export async function requestPhoneVerification() {
  const user = await actionUser();
  if (!user.smsNotificationsEnabled) fail("/my-bookings", "Enable SMS notifications before requesting phone verification.");
  if (!user.phoneVerifiedAt) {
    const previous = await db.accountToken.findFirst({
      where: { userId: user.id, purpose: AccountTokenPurpose.PHONE_VERIFICATION },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (previous && Date.now() - previous.createdAt.getTime() < 2 * 60 * 1000) {
      fail("/my-bookings", "Please wait a few minutes before requesting another verification code.");
    }
    await db.$transaction((tx) => createPhoneVerification(tx, user));
  }
  message("/my-bookings", user.phoneVerifiedAt ? "Your phone is already verified." : "Phone verification sent if the service is configured.");
}

export async function verifyEmailAddress(formData: FormData) {
  const token = field(formData, "token");
  if (token.length < 20 || token.length > 200) fail("/account/verify-email", "This verification link is invalid or expired.");
  const tokenHash = hashToken(token);
  const now = new Date();
  const used = await db.$transaction(async (tx) => {
    const accountToken = await tx.accountToken.findFirst({
      where: { tokenHash, purpose: AccountTokenPurpose.EMAIL_VERIFICATION, consumedAt: null, expiresAt: { gt: now } },
      select: { id: true, userId: true },
    });
    if (!accountToken) return false;
    const consumed = await tx.accountToken.updateMany({
      where: { id: accountToken.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (!consumed.count) return false;
    await tx.user.update({ where: { id: accountToken.userId }, data: { emailVerifiedAt: now } });
    return true;
  });
  if (!used) fail("/account/verify-email", "This verification link is invalid or expired.");
  message("/login", "Email verified. You can now sign in and book appointments.");
}

export async function verifyPhoneNumber(formData: FormData) {
  const challengeId = field(formData, "challengeId");
  const code = field(formData, "code");
  if (!/^[a-f0-9]{24}$/.test(challengeId) || !/^\d{6}$/.test(code)) fail("/account/verify-phone", "This verification code is invalid or expired.");
  const user = await actionUser();
  const now = new Date();
  const token = await db.accountToken.findFirst({
    where: {
      id: challengeId,
      userId: user.id,
      purpose: AccountTokenPurpose.PHONE_VERIFICATION,
      consumedAt: null,
      expiresAt: { gt: now },
      attempts: { lt: 5 },
    },
    select: { id: true, tokenHash: true },
  });
  const expected = token ? Buffer.from(token.tokenHash, "hex") : Buffer.alloc(0);
  const actual = Buffer.from(hashOneTimeCode(user.id, challengeId, code), "hex");
  if (!token || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    if (token) {
      await db.accountToken.updateMany({
        where: { id: token.id, attempts: { lt: 5 }, consumedAt: null },
        data: { attempts: { increment: 1 } },
      });
    }
    fail("/account/verify-phone", "This verification code is invalid or expired.");
  }
  const updated = await db.$transaction(async (tx) => {
    const consumed = await tx.accountToken.updateMany({
      where: { id: token.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (!consumed.count) return false;
    await tx.user.update({ where: { id: user.id }, data: { phoneVerifiedAt: now } });
    return true;
  });
  if (!updated) fail("/account/verify-phone", "This verification code is invalid or expired.");
  message("/my-bookings", "Phone number verified.");
}

export async function requestPasswordReset(formData: FormData) {
  const email = normalizeEmail(field(formData, "email"));
  if (isValidEmail(email)) {
    const user = await db.user.findUnique({ where: { email }, select: { id: true, name: true, email: true, active: true } });
    if (user?.active) {
      const previous = await db.accountToken.findFirst({
        where: { userId: user.id, purpose: AccountTokenPurpose.PASSWORD_RESET },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (!previous || Date.now() - previous.createdAt.getTime() >= 2 * 60 * 1000) {
        const token = randomBytes(32).toString("base64url");
        await db.$transaction(async (tx) => {
          await tx.accountToken.deleteMany({
            where: { userId: user.id, purpose: AccountTokenPurpose.PASSWORD_RESET, consumedAt: null },
          });
          await tx.accountToken.create({
            data: {
              userId: user.id,
              purpose: AccountTokenPurpose.PASSWORD_RESET,
              tokenHash: hashToken(token),
              expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            },
          });
          await enqueueAccountMessage(tx, {
            channel: NotificationChannel.EMAIL,
            recipient: user.email,
            subject: "Reset your Appointly password",
            body: `${user.name}, reset your password within 30 minutes: ${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "")}/account/reset-password?token=${encodeURIComponent(token)}`,
            dedupeKey: `password-reset:${user.id}:${randomBytes(12).toString("hex")}`,
          });
        });
      }
    }
  }
  message("/forgot-password", "If the address belongs to an active account, password reset instructions will be sent.");
}

export async function resetPassword(formData: FormData) {
  const token = field(formData, "token");
  const password = field(formData, "password");
  if (token.length < 20 || token.length > 200 || !isStrongPassword(password)) {
    fail("/account/reset-password", "Use a valid reset link and a password of 12–72 UTF-8 bytes.");
  }
  const tokenHash = hashToken(token);
  const now = new Date();
  const passwordHash = await bcrypt.hash(password, 12);
  const userId = await db.$transaction(async (tx) => {
    const accountToken = await tx.accountToken.findFirst({
      where: { tokenHash, purpose: AccountTokenPurpose.PASSWORD_RESET, consumedAt: null, expiresAt: { gt: now } },
      select: { id: true, userId: true },
    });
    if (!accountToken) return null;
    const consumed = await tx.accountToken.updateMany({
      where: { id: accountToken.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (!consumed.count) return null;
    await tx.user.update({ where: { id: accountToken.userId }, data: { passwordHash } });
    await tx.session.deleteMany({ where: { userId: accountToken.userId } });
    await tx.adminMfaChallenge.deleteMany({ where: { userId: accountToken.userId } });
    return accountToken.userId;
  });
  if (!userId) fail("/account/reset-password", "This password reset link is invalid or expired.");
  message("/login", "Password reset. Sign in with your new password.");
}

export async function loginUser(formData: FormData) {
  const email = normalizeEmail(field(formData, "email"));
  const password = field(formData, "password");
  if (!isValidEmail(email) || password.length === 0 || Buffer.byteLength(password, "utf8") > 72) {
    fail("/login", "Invalid email or password.");
  }

  const user = await db.user.findUnique({ where: { email } });
  const forwardedAddress = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim();
  const clientAddress = forwardedAddress?.slice(0, 100) || "unknown";
  const throttleKeys = loginThrottleKeys(email, clientAddress);
  const throttles = await db.loginThrottle.findMany({ where: { id: { in: throttleKeys } } });
  if (throttles.some((throttle) => throttle.blockedUntil && throttle.blockedUntil > new Date())) {
    fail("/login", "Sign-in is temporarily unavailable. Try again later.");
  }

  const matches = await bcrypt.compare(password, user?.passwordHash ?? (await dummyPasswordHash));
  if (!user || !matches || !user.active) {
    await recordLoginFailure(throttleKeys);
    fail("/login", "Invalid email or password.");
  }

  await db.loginThrottle.deleteMany({ where: { id: { in: throttleKeys } } });
  if (user.role === UserRole.ADMIN) {
    if (!user.emailVerifiedAt) {
      await db.$transaction((tx) => createEmailVerification(tx, user));
      message("/login", "Verify the administrator email using the link we sent before signing in.");
    }
    if (!isOneTimeCodeConfigured()) fail("/login", "Administrator email MFA requires AUTH_TOKEN_SECRET to be configured.");
    const code = createAdminCode();
    const challengeId = randomBytes(16).toString("hex");
    const challenge = await db.$transaction(async (tx) => {
      await tx.adminMfaChallenge.deleteMany({ where: { userId: user.id, consumedAt: null } });
      const created = await tx.adminMfaChallenge.create({
        data: {
          id: challengeId,
          userId: user.id,
          codeHash: hashOneTimeCode(user.id, challengeId, code),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });
      await tx.notificationDelivery.create({
        data: {
          dedupeKey: `admin-mfa:${created.id}`,
          channel: NotificationChannel.EMAIL,
          recipient: user.email,
          subject: "Your Appointly administrator sign-in code",
          body: `Your one-time administrator sign-in code is ${code}. It expires in 10 minutes.`,
        },
      });
      return created;
    });
    redirect(`/login?challenge=${encodeURIComponent(challenge.id)}`);
  }
  await setSession(user.id);
  redirect(user.role === UserRole.PROVIDER ? "/provider/dashboard" : "/");
}

export async function verifyAdminMfa(formData: FormData) {
  const challengeId = field(formData, "challengeId");
  const code = field(formData, "code").trim();
  if (!/^[\w-]{1,80}$/.test(challengeId) || !/^\d{6}$/.test(code)) fail("/login", "Invalid or expired sign-in code.");
  const challenge = await db.adminMfaChallenge.findUnique({
    where: { id: challengeId },
    include: { user: { select: { id: true, role: true, active: true, emailVerifiedAt: true } } },
  });
  if (
    !challenge ||
    challenge.consumedAt ||
    challenge.expiresAt <= new Date() ||
    challenge.attempts >= 5 ||
    challenge.user.role !== UserRole.ADMIN ||
    !challenge.user.active ||
    !challenge.user.emailVerifiedAt
  ) {
    fail("/login", "Invalid or expired sign-in code.");
  }
  const expected = Buffer.from(challenge.codeHash, "hex");
  const actual = Buffer.from(hashOneTimeCode(challenge.user.id, challenge.id, code), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    await db.adminMfaChallenge.updateMany({
      where: { id: challenge.id, attempts: { lt: 5 }, consumedAt: null },
      data: { attempts: { increment: 1 } },
    });
    fail("/login", "Invalid or expired sign-in code.");
  }
  const consumed = await db.adminMfaChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null, expiresAt: { gt: new Date() }, attempts: { lt: 5 } },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) fail("/login", "Invalid or expired sign-in code.");
  await setSession(challenge.user.id);
  redirect("/admin");
}

export async function registerCustomer(formData: FormData) {
  const name = formText(formData, "name", 80);
  const email = normalizeEmail(field(formData, "email"));
  const phone = formText(formData, "phone", 20);
  const password = field(formData, "password");
  const smsEnabled = field(formData, "smsNotificationsEnabled") === "on";
  if (smsEnabled && !isOneTimeCodeConfigured()) {
    fail("/register", "SMS verification requires AUTH_TOKEN_SECRET to be configured.");
  }
  if (
    !name ||
    !isValidEmail(email) ||
    !isValidPhone(phone) ||
    (smsEnabled && !isE164Phone(phone)) ||
    !isStrongPassword(password)
  ) {
    fail("/register", "Enter your name, a valid email and phone, and a password of 12–72 UTF-8 bytes. SMS recipients must use international +country-code format.");
  }

  try {
    const user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          name,
          email,
          phone,
          smsNotificationsEnabled: smsEnabled,
          passwordHash: await bcrypt.hash(password, 12),
          role: UserRole.CUSTOMER,
        },
        select: { id: true, email: true, name: true, phone: true, smsNotificationsEnabled: true },
      });
      await createEmailVerification(tx, created);
      if (created.smsNotificationsEnabled) await createPhoneVerification(tx, created);
      return created;
    });
    await setSession(user.id);
  } catch (error) {
    if (isPrismaCode(error, "P2002")) fail("/register", "An account with that email already exists.");
    throw error;
  }
  redirect("/");
}

export async function registerProvider(formData: FormData) {
  const name = formText(formData, "name", 80);
  const email = normalizeEmail(field(formData, "email"));
  const phone = formText(formData, "phone", 20);
  const password = field(formData, "password");
  const smsEnabled = field(formData, "smsNotificationsEnabled") === "on";
  if (smsEnabled && !isOneTimeCodeConfigured()) {
    fail("/provider/register", "SMS verification requires AUTH_TOKEN_SECRET to be configured.");
  }
  const businessName = formText(formData, "businessName", 120);
  const categoryId = field(formData, "categoryId");
  const city = formText(formData, "city", 80);
  const address = formText(formData, "address", 180);
  const timezone = field(formData, "timezone").trim().slice(0, 100);
  const latitude = parseCoordinate(field(formData, "latitude"), -90, 90);
  const longitude = parseCoordinate(field(formData, "longitude"), -180, 180);
  const description = formText(formData, "description", 1000);
  const serviceName = formText(formData, "serviceName", 100);
  const serviceDescription = formText(formData, "serviceDescription", 500);
  const priceCents = parseMoneyToCents(field(formData, "price"));
  const durationMinutes = Number(field(formData, "durationMinutes"));

  if (
    !name ||
    !isValidEmail(email) ||
    !isValidPhone(phone) ||
    (smsEnabled && !isE164Phone(phone)) ||
    !isStrongPassword(password) ||
    !businessName ||
    !categoryId ||
    !city ||
    !address ||
    !serviceName ||
    priceCents === null ||
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 5 ||
    durationMinutes > 480 ||
    !isValidTimeZone(timezone)
    || latitude === undefined
    || longitude === undefined
    || (latitude === null) !== (longitude === null)
  ) {
    fail("/provider/register", "Complete all fields with valid business, service, price, duration, and time-zone details.");
  }

  const category = await db.category.findFirst({ where: { id: categoryId, active: true } });
  if (!category) fail("/provider/register", "Select an active service category.");
  try {
    const user = await db.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          name,
          email,
          phone,
          smsNotificationsEnabled: smsEnabled,
          passwordHash: await bcrypt.hash(password, 12),
          role: UserRole.PROVIDER,
        },
        select: { id: true, email: true, name: true, phone: true, smsNotificationsEnabled: true },
      });
      await createEmailVerification(tx, createdUser);
      if (createdUser.smsNotificationsEnabled) await createPhoneVerification(tx, createdUser);
      const business = await tx.business.create({
        data: {
          ownerId: createdUser.id,
          categoryId,
          name: businessName,
          city,
          latitude,
          longitude,
          timezone,
          address,
          description,
          services: {
            create: { name: serviceName, description: serviceDescription, priceCents, durationMinutes },
          },
          availability: {
            create: [1, 2, 3, 4, 5].map((weekday) => ({
              weekday,
              openingMinute: 540,
              closingMinute: 1020,
            })),
          },
        },
        select: { id: true },
      });
      await writeAudit(tx, createdUser.id, "BUSINESS_SUBMITTED", "Business", business.id);
      return createdUser;
    });
    await setSession(user.id);
  } catch (error) {
    if (isPrismaCode(error, "P2002")) fail("/provider/register", "An account with that email already exists.");
    throw error;
  }
  redirect("/provider/dashboard?message=Business submitted for review.");
}

export async function updateBusiness(formData: FormData) {
  const user = await actionUser([UserRole.PROVIDER]);
  const businessId = field(formData, "businessId");
  const categoryId = field(formData, "categoryId");
  const name = formText(formData, "name", 120);
  const city = formText(formData, "city", 80);
  const address = formText(formData, "address", 180);
  const timezone = field(formData, "timezone").trim().slice(0, 100);
  const latitude = parseCoordinate(field(formData, "latitude"), -90, 90);
  const longitude = parseCoordinate(field(formData, "longitude"), -180, 180);
  const description = formText(formData, "description", 1000);
  const category = await db.category.findFirst({ where: { id: categoryId, active: true } });
  if (
    !name ||
    !city ||
    !address ||
    !description ||
    !isValidTimeZone(timezone) ||
    !category ||
    latitude === undefined ||
    longitude === undefined ||
    (latitude === null) !== (longitude === null)
  ) {
    fail("/provider/dashboard", "Enter valid business details and choose an active category.");
  }

  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { id: true, ownerId: true, status: true, timezone: true },
  });
  if (!business || !canManageBusiness(user.role, user.id, business.ownerId)) {
    fail("/provider/dashboard", "Business not found or you do not have access.");
  }
  try {
    await db.$transaction(
      async (tx) => {
        if (timezone !== business.timezone) {
          const activeBookings = await tx.booking.count({
            where: { businessId: business.id, status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] } },
          });
          if (activeBookings) throw new Error("TIMEZONE_LOCKED");
        }
        await tx.business.update({
          where: { id: business.id },
          data: {
            name,
            city,
            latitude,
            longitude,
            address,
            timezone,
            description,
            categoryId,
            status: business.status === BusinessStatus.APPROVED ? BusinessStatus.PENDING : business.status,
          },
        });
        await writeAudit(tx, user.id, "BUSINESS_UPDATED", "Business", business.id);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "TIMEZONE_LOCKED") {
      fail("/provider/dashboard", "The business time zone cannot change while bookings are pending or confirmed.");
    }
    if (isPrismaCode(error, "P2034")) fail("/provider/dashboard", "Bookings changed while saving. Refresh and try again.");
    throw error;
  }
  message("/provider/dashboard", "Business details saved. Changes to approved listings require admin review.");
}

export async function createService(formData: FormData) {
  const user = await actionUser([UserRole.PROVIDER]);
  const businessId = field(formData, "businessId");
  const name = formText(formData, "name", 100);
  const description = formText(formData, "description", 500);
  const priceCents = parseMoneyToCents(field(formData, "price"));
  const durationMinutes = Number(field(formData, "durationMinutes"));
  const business = await db.business.findUnique({ where: { id: businessId }, select: { id: true, ownerId: true } });
  if (!business || business.ownerId !== user.id) fail("/provider/dashboard", "Business not found or you do not have access.");
  if (!name || priceCents === null || !Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) {
    fail("/provider/dashboard", "Enter a service name, non-negative price, and duration between 5 and 480 minutes.");
  }
  try {
    await db.$transaction(async (tx) => {
      const service = await tx.service.create({ data: { businessId, name, description, priceCents, durationMinutes } });
      await writeAudit(tx, user.id, "SERVICE_CREATED", "Service", service.id);
    });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) fail("/provider/dashboard", "A service with that name already exists.");
    throw error;
  }
  message("/provider/dashboard", "Service added.");
}

export async function updateService(formData: FormData) {
  const user = await actionUser([UserRole.PROVIDER]);
  const serviceId = field(formData, "serviceId");
  const name = formText(formData, "name", 100);
  const description = formText(formData, "description", 500);
  const priceCents = parseMoneyToCents(field(formData, "price"));
  const durationMinutes = Number(field(formData, "durationMinutes"));
  const service = await db.service.findUnique({
    where: { id: serviceId },
    select: { id: true, businessId: true, business: { select: { ownerId: true } } },
  });
  if (!service || service.business.ownerId !== user.id) fail("/provider/dashboard", "Service not found or you do not have access.");
  if (!name || priceCents === null || !Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) {
    fail("/provider/dashboard", "Enter a valid service name, price, and duration.");
  }
  try {
    await db.$transaction(async (tx) => {
      await tx.service.update({
        where: { id: service.id },
        data: { name, description, priceCents, durationMinutes, active: field(formData, "active") === "on" },
      });
      await writeAudit(tx, user.id, "SERVICE_UPDATED", "Service", service.id);
    });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) fail("/provider/dashboard", "A service with that name already exists.");
    throw error;
  }
  message("/provider/dashboard", "Service saved.");
}

export async function setAvailability(formData: FormData) {
  const user = await actionUser([UserRole.PROVIDER]);
  const businessId = field(formData, "businessId");
  const weekday = Number(field(formData, "weekday"));
  const windows = parseTimeWindows(field(formData, "windows"));
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    fail("/provider/dashboard", "Choose a valid weekday.");
  }
  if (windows === null) fail("/provider/dashboard", "Use comma-separated hours such as 09:00-12:00,13:00-17:00.");
  try {
    await db.$transaction((tx) => saveAvailability(tx, user, businessId, weekday, windows));
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_AVAILABILITY") {
      fail("/provider/dashboard", "Hours must be valid, non-overlapping time ranges.");
    }
    if (error instanceof Error && error.message === "SCHEDULE_CONFLICT") {
      fail("/provider/dashboard", "Those hours would leave an existing booking outside opening hours.");
    }
    throw error;
  }
  message("/provider/dashboard", windows.length ? "Availability saved." : "Availability removed for that day.");
}

export async function saveBusinessScheduleException(formData: FormData) {
  const user = await actionUser([UserRole.PROVIDER]);
  const businessId = field(formData, "businessId");
  const date = field(formData, "date");
  const isClosed = field(formData, "isClosed") === "on";
  const windows = isClosed ? [] : parseTimeWindows(field(formData, "windows"));
  if (!isClosed && (windows === null || windows.length === 0)) {
    fail("/provider/dashboard", "Enter one or more valid time ranges, or mark the date closed.");
  }
  try {
    await db.$transaction((tx) => saveScheduleException(tx, user, businessId, date, isClosed, windows ?? []));
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_AVAILABILITY") {
      fail("/provider/dashboard", "Hours must be valid, non-overlapping time ranges.");
    }
    if (error instanceof Error && error.message === "INVALID_EXCEPTION_DATE") {
      fail("/provider/dashboard", "Choose a valid date from today through the next 365 days.");
    }
    if (error instanceof Error && error.message === "SCHEDULE_CONFLICT") {
      fail("/provider/dashboard", "Those hours would leave an existing booking outside the date's opening hours.");
    }
    if (error instanceof Error && error.message === "NOT_ALLOWED") {
      fail("/provider/dashboard", "Business not found or you do not have access.");
    }
    throw error;
  }
  message("/provider/dashboard", "Calendar exception saved.");
}

export async function removeBusinessScheduleException(formData: FormData) {
  const user = await actionUser([UserRole.PROVIDER]);
  try {
    await db.$transaction((tx) =>
      removeScheduleExceptionWorkflow(tx, user, field(formData, "businessId"), field(formData, "exceptionId")),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_ALLOWED") {
      fail("/provider/dashboard", "Calendar exception not found or you do not have access.");
    }
    throw error;
  }
  message("/provider/dashboard", "Calendar exception removed.");
}

function bookingFailurePath(businessId: string, error: unknown): never {
  if (error instanceof Error && error.message === "CONFLICT") fail(`/business/${businessId}`, "That time overlaps another booking. Choose a different slot.");
  if (error instanceof Error && error.message === "OUTSIDE_HOURS") fail(`/business/${businessId}`, "That time is outside this business's opening hours.");
  if (error instanceof Error && error.message === "PAST") fail(`/business/${businessId}`, "Choose an appointment in the future.");
  if (error instanceof Error && error.message === "INVALID_DATE") fail(`/business/${businessId}`, "Choose a valid date within the next 90 days.");
  if (error instanceof Error && error.message === "INVALID_LOCAL_TIME") fail(`/business/${businessId}`, "That local time is ambiguous or does not exist because of a daylight-saving change.");
  if (error instanceof Error && error.message === "NOT_ALLOWED") fail("/my-bookings", "This booking can no longer be changed.");
  if (error instanceof Error && error.message === "PAYMENT_REQUIRES_SUPPORT") {
    fail("/my-bookings", "A paid booking cannot be rescheduled online. Contact the business for help.");
  }
  fail(`/business/${businessId}`, "This service is not currently available for booking.");
}

export async function submitBooking(formData: FormData) {
  const user = await actionUser([UserRole.CUSTOMER]);
  if (!user.emailVerifiedAt) fail("/my-bookings", "Verify your email before requesting an appointment.");
  const businessId = field(formData, "businessId");
  const serviceId = field(formData, "serviceId");
  const date = field(formData, "date");
  const startMinute = parseMinuteOfDay(field(formData, "time"));
  const details = formText(formData, "details", 500);
  if (!businessId || !serviceId || startMinute === null || !date) {
    fail(`/business/${businessId}`, "Choose a service, date, and valid time.");
  }
  try {
    await db.$transaction(
      (tx) => createBookingRequest(tx, user, businessId, serviceId, date, startMinute, details),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (isPrismaCode(error, "P2034") || isPrismaCode(error, "P2004")) {
      fail(`/business/${businessId}`, "That slot was just booked. Select another time.");
    }
    bookingFailurePath(businessId, error);
  }
  redirect("/my-bookings?message=Booking request submitted.");
}

export async function cancelBooking(formData: FormData) {
  const user = await actionUser([UserRole.CUSTOMER]);
  const bookingId = field(formData, "bookingId");
  try {
    await db.$transaction(
      async (tx) => {
        const booking = await tx.booking.findFirst({
          where: { id: bookingId },
        });
        const isFuture =
          booking &&
          isFutureLocalAppointment(
            booking.date.toISOString().slice(0, 10),
            booking.startMinute,
            booking.timezone,
          );
        if (
          !booking ||
          !canCustomerManageBooking(user.role, user.id, booking.customerId, booking.status, Boolean(isFuture))
        ) {
          throw new Error("NOT_ALLOWED");
        }
        await tx.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.CANCELLED } });
        const appointment = getLocalAppointmentInstant(
          booking.date.toISOString().slice(0, 10),
          booking.startMinute,
          booking.timezone,
        );
        const refundEligible = appointment !== null && appointment.getTime() - Date.now() >= 24 * 60 * 60 * 1000;
        await tx.payment.updateMany({
          where: { bookingId: booking.id, status: { in: [PaymentStatus.PENDING, PaymentStatus.PAID] } },
          data: { bookingCancelledAt: new Date(), refundEligible },
        });
        await enqueueBookingUpdate(tx, booking.id, BookingStatus.CANCELLED);
        await writeAudit(tx, user.id, "BOOKING_CANCELLED", "Booking", booking.id);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_ALLOWED") {
      fail("/my-bookings", "This booking is no longer eligible for cancellation.");
    }
    if (isPrismaCode(error, "P2034")) fail("/my-bookings", "The booking changed. Refresh and try again.");
    throw error;
  }
  await cancelPaymentLink(bookingId);
  await issueEligibleRefund(bookingId, "CUSTOMER");
  message("/my-bookings", "Booking cancelled.");
}

export async function startBookingPayment(formData: FormData) {
  const user = await actionUser([UserRole.CUSTOMER]);
  const bookingId = field(formData, "bookingId");
  if (!isRazorpayConfigured()) fail("/my-bookings", "Online payments are not configured yet. Contact the business to arrange payment.");
  const booking = await db.booking.findFirst({
    where: { id: bookingId, customerId: user.id, status: BookingStatus.CONFIRMED },
    include: {
      business: { select: { name: true } },
      service: { select: { name: true } },
      customer: { select: { name: true, email: true, phone: true } },
      payment: true,
    },
  });
  if (!booking) fail("/my-bookings", "Only confirmed bookings can be paid online.");
  if (booking.payment?.status === PaymentStatus.PAID) message("/my-bookings", "This booking is already paid.");
  if (booking.payment?.paymentLinkUrl && booking.payment.status === PaymentStatus.PENDING) {
    redirect(booking.payment.paymentLinkUrl);
  }

  let payment = await db.payment.upsert({
    where: { bookingId },
    create: { bookingId, amountPaise: booking.priceCents },
    update: {},
  });
  if (payment.status === PaymentStatus.FAILED) {
    await db.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.FAILED },
      data: {
        status: PaymentStatus.PENDING,
        paymentLinkId: null,
        paymentLinkUrl: null,
        bookingCancelledAt: null,
        refundEligible: false,
      },
    });
    payment = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
  }
  if (payment.status !== PaymentStatus.PENDING || payment.amountPaise !== booking.priceCents) {
    fail("/my-bookings", "Payment is already processed or unavailable for this booking.");
  }
  if (payment.linkCreationStartedAt && Date.now() - payment.linkCreationStartedAt.getTime() < 60_000) {
    fail("/my-bookings", "A payment link is already being created. Please wait a moment.");
  }
  const claimed = await db.payment.updateMany({
    where: {
      id: payment.id,
      status: PaymentStatus.PENDING,
      paymentLinkUrl: null,
      OR: [{ linkCreationStartedAt: null }, { linkCreationStartedAt: { lt: new Date(Date.now() - 60_000) } }],
    },
    data: { linkCreationStartedAt: new Date() },
  });
  if (!claimed.count) {
    const refreshed = await db.payment.findUnique({ where: { id: payment.id }, select: { paymentLinkUrl: true } });
    if (refreshed?.paymentLinkUrl) redirect(refreshed.paymentLinkUrl);
    fail("/my-bookings", "A payment link is already being created. Please try again shortly.");
  }
  let link: Awaited<ReturnType<typeof createRazorpayPaymentLink>>;
  try {
    link = await createRazorpayPaymentLink({
      amountPaise: payment.amountPaise,
      referenceId: booking.id,
      customerName: booking.customer.name,
      customerEmail: booking.customer.email,
      customerPhone: booking.customer.phone,
      description: `${booking.service.name} at ${booking.business.name}`,
    });
  } catch (error) {
    await db.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.PENDING, paymentLinkId: null },
      data: { status: PaymentStatus.FAILED, linkCreationStartedAt: null },
    });
    console.error("Razorpay checkout link creation failed", {
      bookingId,
      error: error instanceof Error ? error.message : "Unknown payment error",
    });
    fail("/my-bookings", "Could not create a payment link. Try again later.");
  }
  await db.payment.update({
    where: { id: payment.id },
    data: { paymentLinkId: link.id, paymentLinkUrl: link.url, linkCreationStartedAt: null },
  });
  redirect(link.url);
}

export async function rescheduleBooking(formData: FormData) {
  const user = await actionUser([UserRole.CUSTOMER]);
  const bookingId = field(formData, "bookingId");
  const date = field(formData, "date");
  const startMinute = parseMinuteOfDay(field(formData, "time"));
  const details = formText(formData, "details", 500);
  const booking = await db.booking.findFirst({
    where: { id: bookingId, customerId: user.id },
    select: { id: true, businessId: true, serviceId: true, status: true, date: true, startMinute: true, timezone: true },
  });
  if (
    !booking ||
    (booking.status !== BookingStatus.PENDING && booking.status !== BookingStatus.CONFIRMED) ||
    !isFutureLocalAppointment(booking.date.toISOString().slice(0, 10), booking.startMinute, booking.timezone) ||
    !date ||
    startMinute === null
  ) {
    fail("/my-bookings", "This booking is no longer eligible for rescheduling.");
  }
  try {
    await db.$transaction(
      (tx) =>
        createBookingRequest(tx, user, booking.businessId, booking.serviceId, date, startMinute, details, booking.id),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (isPrismaCode(error, "P2034") || isPrismaCode(error, "P2004")) {
      fail("/my-bookings", "That slot was just booked. Choose another time.");
    }
    bookingFailurePath(booking.businessId, error);
  }
  await cancelPaymentLink(booking.id);
  message("/my-bookings", "Booking rescheduled and returned to pending confirmation.");
}

export async function submitReview(formData: FormData) {
  const user = await actionUser([UserRole.CUSTOMER]);
  const bookingId = field(formData, "bookingId");
  const rating = Number(field(formData, "rating"));
  const body = formText(formData, "body", 1000);
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, businessId: true, customerId: true, status: true },
  });
  if (
    !booking ||
    !canReviewBooking(user.role, user.id, booking.customerId, booking.status) ||
    !Number.isInteger(rating) ||
    rating < 1 ||
    rating > 5 ||
    body.length < 5
  ) {
    fail("/my-bookings", "Only completed bookings can be reviewed. Provide a rating and at least 5 characters.");
  }
  try {
    await db.$transaction(async (tx) => {
      await tx.review.create({ data: { bookingId, businessId: booking.businessId, authorId: user.id, rating, body } });
      await writeAudit(tx, user.id, "REVIEW_SUBMITTED", "Review", bookingId);
    });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) fail("/my-bookings", "A review has already been submitted for this booking.");
    throw error;
  }
  message("/my-bookings", "Review submitted for moderation.");
}

export async function setProviderBookingStatus(formData: FormData) {
  const user = await actionUser([UserRole.PROVIDER]);
  const bookingId = field(formData, "bookingId");
  const status = field(formData, "status") as BookingStatus;
  await changeBookingStatus(user.id, bookingId, status, "/provider/dashboard", user.id);
}

async function changeBookingStatus(
  actorId: string,
  bookingId: string,
  status: BookingStatus,
  path: string,
  providerOwnerId?: string,
) {
  if (!Object.values(BookingStatus).includes(status)) fail(path, "Choose a valid booking status.");
  try {
    await db.$transaction(
      async (tx) => {
        const booking = await tx.booking.findUnique({
          where: { id: bookingId },
          include: { business: { select: { ownerId: true } } },
        });
        if (!booking || (providerOwnerId && booking.business.ownerId !== providerOwnerId)) {
          throw new Error("NOT_ALLOWED");
        }
        if (!canTransitionBooking(booking.status, status)) throw new Error("INVALID_TRANSITION");
        if (
          status === BookingStatus.COMPLETED &&
          isFutureLocalAppointment(
            booking.date.toISOString().slice(0, 10),
            booking.startMinute + booking.durationMinutes,
            booking.timezone,
          )
        ) {
          throw new Error("NOT_FINISHED");
        }
        await tx.booking.update({ where: { id: booking.id }, data: { status } });
        if (status === BookingStatus.CANCELLED) {
          await tx.payment.updateMany({
            where: { bookingId: booking.id, status: { in: [PaymentStatus.PENDING, PaymentStatus.PAID] } },
            data: { bookingCancelledAt: new Date(), refundEligible: true },
          });
        }
        await enqueueBookingUpdate(tx, booking.id, status);
        await writeAudit(tx, actorId, "BOOKING_STATUS_CHANGED", "Booking", booking.id, { status });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_ALLOWED") fail(path, "Booking not found or you do not have access.");
    if (error instanceof Error && error.message === "INVALID_TRANSITION") fail(path, "That booking status change is not allowed.");
    if (error instanceof Error && error.message === "NOT_FINISHED") fail(path, "A booking can be marked completed only after its scheduled end time.");
    if (isPrismaCode(error, "P2034")) fail(path, "The booking changed. Refresh and try again.");
    throw error;
  }
  if (status === BookingStatus.CANCELLED) await issueEligibleRefund(bookingId, "PROVIDER");
  message(path, "Booking status updated.");
}

async function issueEligibleRefund(bookingId: string, cancelledBy: "CUSTOMER" | "PROVIDER") {
  const payment = await db.payment.findUnique({ where: { bookingId } });
  if (!payment || payment.status !== PaymentStatus.PAID || !payment.externalPaymentId) return;
  const eligible = cancelledBy === "PROVIDER" || payment.refundEligible;
  if (!eligible) return;

  const reserved = await db.payment.updateMany({
    where: { id: payment.id, status: PaymentStatus.PAID },
    data: { status: PaymentStatus.REFUND_PENDING },
  });
  if (!reserved.count) return;
  try {
    const refund = await refundRazorpayPayment(payment.externalPaymentId, payment.amountPaise);
    await db.payment.update({
      where: { id: payment.id },
      data: {
        status: refund.processed ? PaymentStatus.REFUNDED : PaymentStatus.REFUND_PENDING,
        refundId: refund.id,
        lastRefundError: null,
      },
    });
  } catch (error) {
    await db.payment.update({
      where: { id: payment.id },
      data: { lastRefundError: error instanceof Error ? error.message.slice(0, 300) : "Unknown refund error" },
    });
    console.error("Razorpay refund requires reconciliation", {
      bookingId,
      error: error instanceof Error ? error.message : "Unknown refund error",
    });
  }
}

async function cancelPaymentLink(bookingId: string) {
  const payment = await db.payment.findUnique({
    where: { bookingId },
    select: { paymentLinkId: true, status: true },
  });
  if (!payment?.paymentLinkId || payment.status === PaymentStatus.PAID || payment.status === PaymentStatus.REFUNDED) return;
  try {
    await cancelRazorpayPaymentLink(payment.paymentLinkId);
  } catch (error) {
    console.error("Razorpay payment link could not be cancelled", {
      bookingId,
      error: error instanceof Error ? error.message : "Unknown cancellation error",
    });
  }
}

export async function setAdminBookingStatus(formData: FormData) {
  const user = await actionUser([UserRole.ADMIN]);
  await changeBookingStatus(user.id, field(formData, "bookingId"), field(formData, "status") as BookingStatus, "/admin");
}

export async function setBusinessStatus(formData: FormData) {
  const user = await actionUser([UserRole.ADMIN]);
  const businessId = field(formData, "businessId");
  const status = field(formData, "status") as BusinessStatus;
  if (!Object.values(BusinessStatus).includes(status)) fail("/admin", "Choose a valid business status.");
  await db.$transaction(async (tx) => {
    const business = await tx.business.findUnique({ where: { id: businessId }, select: { id: true } });
    if (!business) fail("/admin", "Business not found.");
    await tx.business.update({ where: { id: business.id }, data: { status } });
    await writeAudit(tx, user.id, "BUSINESS_STATUS_CHANGED", "Business", business.id, { status });
  });
  message("/admin", "Business status updated.");
}

export async function setUserActive(formData: FormData) {
  const user = await actionUser([UserRole.ADMIN]);
  const userId = field(formData, "userId");
  const active = field(formData, "active") === "true";
  try {
    await db.$transaction((tx) => updateAccountActive(tx, user.id, userId, active));
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_ALLOWED") fail("/admin", "That account cannot be changed here.");
    if (error instanceof Error && error.message === "NOT_ADMIN") fail("/", "You do not have permission to do that.");
    throw error;
  }
  message("/admin", "Account access updated.");
}

export async function createCategory(formData: FormData) {
  const user = await actionUser([UserRole.ADMIN]);
  const name = formText(formData, "name", 80);
  if (name.length < 2) fail("/admin", "Category name must contain at least 2 characters.");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) fail("/admin", "Choose a category name containing letters or numbers.");
  try {
    await db.$transaction(async (tx) => {
      const category = await tx.category.create({ data: { name, slug } });
      await writeAudit(tx, user.id, "CATEGORY_CREATED", "Category", category.id);
    });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) fail("/admin", "That category already exists.");
    throw error;
  }
  message("/admin", "Category created.");
}

export async function setCategoryActive(formData: FormData) {
  const user = await actionUser([UserRole.ADMIN]);
  const categoryId = field(formData, "categoryId");
  const active = field(formData, "active") === "true";
  await db.$transaction(async (tx) => {
    await tx.category.update({ where: { id: categoryId }, data: { active } });
    await writeAudit(tx, user.id, active ? "CATEGORY_ACTIVATED" : "CATEGORY_DEACTIVATED", "Category", categoryId);
  });
  message("/admin", "Category availability updated.");
}

export async function setReviewStatus(formData: FormData) {
  const user = await actionUser([UserRole.ADMIN]);
  const reviewId = field(formData, "reviewId");
  const status = field(formData, "status") as ReviewStatus;
  if (!Object.values(ReviewStatus).includes(status)) fail("/admin", "Choose a valid review status.");
  try {
    await db.$transaction((tx) => setReviewModeration(tx, user.id, reviewId, status));
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_ADMIN") fail("/", "You do not have permission to do that.");
    if (error instanceof Error && error.message === "NOT_FOUND") fail("/admin", "Review not found.");
    throw error;
  }
  message("/admin", "Review moderation saved.");
}
