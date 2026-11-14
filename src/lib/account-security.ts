import "server-only";

import { AccountTokenPurpose, NotificationChannel, Prisma } from "@appointly/prisma-client";
import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";

import { enqueueAccountMessage } from "@/lib/notifications";

const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export async function createEmailVerification(
  tx: Prisma.TransactionClient,
  user: { id: string; email: string; name: string },
) {
  const token = randomBytes(32).toString("base64url");
  await tx.accountToken.deleteMany({
    where: { userId: user.id, purpose: AccountTokenPurpose.EMAIL_VERIFICATION, consumedAt: null },
  });
  await tx.accountToken.create({
    data: {
      userId: user.id,
      purpose: AccountTokenPurpose.EMAIL_VERIFICATION,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  await enqueueAccountMessage(tx, {
    channel: NotificationChannel.EMAIL,
    recipient: user.email,
    subject: "Verify your Appointly email",
    body: `${user.name}, verify your email within 24 hours: ${appUrl()}/account/verify-email?token=${encodeURIComponent(token)}`,
    dedupeKey: `email-verification:${user.id}:${randomBytes(12).toString("hex")}`,
  });
}

export async function createPhoneVerification(
  tx: Prisma.TransactionClient,
  user: { id: string; phone: string },
) {
  const code = String(randomInt(100000, 1_000_000));
  const challenge = randomBytes(12).toString("hex");
  await tx.accountToken.deleteMany({
    where: { userId: user.id, purpose: AccountTokenPurpose.PHONE_VERIFICATION, consumedAt: null },
  });
  await tx.accountToken.create({
    data: {
      id: challenge,
      userId: user.id,
      purpose: AccountTokenPurpose.PHONE_VERIFICATION,
      tokenHash: hashOneTimeCode(user.id, challenge, code),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });
  await enqueueAccountMessage(tx, {
    channel: NotificationChannel.SMS,
    recipient: user.phone,
    subject: "",
    body: `Appointly verification code: ${code}. Enter it at ${appUrl()}/account/verify-phone?challenge=${challenge}. It expires in 10 minutes.`,
    dedupeKey: `phone-verification:${user.id}:${challenge}`,
  });
  return challenge;
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createAdminCode() {
  return String(randomInt(100000, 1_000_000));
}

export function isOneTimeCodeConfigured() {
  return Buffer.byteLength(process.env.AUTH_TOKEN_SECRET ?? "", "utf8") >= 32;
}

export function hashOneTimeCode(userId: string, challengeId: string, code: string) {
  const secret = process.env.AUTH_TOKEN_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("AUTH_TOKEN_SECRET must contain at least 32 UTF-8 bytes to use one-time codes.");
  }
  return createHmac("sha256", secret).update(`${userId}:${challengeId}:${code}`).digest("hex");
}
