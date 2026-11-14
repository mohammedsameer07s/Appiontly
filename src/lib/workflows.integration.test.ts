import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  BookingStatus,
  BusinessStatus,
  PrismaClient,
  ReviewStatus,
  UserRole,
} from "@appointly/prisma-client";

import {
  activePublicBusinessFilter,
  createBookingRequest,
  saveAvailability,
  saveScheduleException,
  setAccountActive,
  setReviewModeration,
} from "./workflows";

const databaseUrl = process.env.DATABASE_URL_TEST;
if (!databaseUrl?.trim()) {
  throw new Error("DATABASE_URL_TEST is required; run `npm run test:workflow` to provision an isolated local database.");
}

function expectWorkflowError(promise: Promise<unknown>, code: string) {
  return assert.rejects(promise, (error: unknown) => error instanceof Error && error.message === code);
}

function tomorrowInTimeZone(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const date = new Date(Date.UTC(
    Number(parts.find((part) => part.type === "year")?.value),
    Number(parts.find((part) => part.type === "month")?.value) - 1,
    Number(parts.find((part) => part.type === "day")?.value) + 1,
  ));
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number) {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

test(
  "database workflows enforce booking availability, provider ownership, and admin account/review controls",
  async () => {
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = randomUUID();
    const email = (role: string) => `${role}-${suffix}@appointly.test`;
    const timeZone = "Asia/Kolkata";
    let categoryId: string | undefined;
    let businessId: string | undefined;
    let serviceId: string | undefined;
    let customerId: string | undefined;
    let providerId: string | undefined;
    let adminId: string | undefined;
    let secondCustomerId: string | undefined;
    let reviewId: string | undefined;
    let sessionId: string | undefined;
    const bookingIds: string[] = [];

    try {
      const [customer, provider, admin, secondCustomer, category] = await Promise.all([
        prisma.user.create({ data: { name: "Workflow Customer", email: email("customer"), phone: "1234567890", passwordHash: "test", role: UserRole.CUSTOMER } }),
        prisma.user.create({ data: { name: "Workflow Provider", email: email("provider"), phone: "1234567891", passwordHash: "test", role: UserRole.PROVIDER } }),
        prisma.user.create({ data: { name: "Workflow Admin", email: email("admin"), phone: "1234567892", passwordHash: "test", role: UserRole.ADMIN } }),
        prisma.user.create({ data: { name: "Workflow Other", email: email("other"), phone: "1234567893", passwordHash: "test", role: UserRole.CUSTOMER } }),
        prisma.category.create({ data: { name: `Workflow ${suffix}`, slug: `workflow-${suffix}` } }),
      ]);
      customerId = customer.id;
      providerId = provider.id;
      adminId = admin.id;
      secondCustomerId = secondCustomer.id;
      categoryId = category.id;
      const business = await prisma.business.create({
        data: {
          ownerId: provider.id,
          categoryId: category.id,
          name: `Workflow Business ${suffix}`,
          city: "Test City",
          timezone: timeZone,
          address: "Test address",
          description: "Test workflow business",
          status: BusinessStatus.APPROVED,
          services: { create: { name: "Workflow service", priceCents: 5000, durationMinutes: 30 } },
          availability: { create: Array.from({ length: 7 }, (_, weekday) => ({ weekday, openingMinute: 0, closingMinute: 1440 })) },
        },
        include: { services: true },
      });
      businessId = business.id;
      serviceId = business.services[0].id;

      await prisma.$transaction((tx) =>
        saveAvailability(tx, provider, business.id, 1, [{ openingMinute: 540, closingMinute: 1020 }]),
      );
      const savedAvailability = await prisma.availability.findFirst({
        where: { businessId: business.id, weekday: 1 },
        orderBy: { openingMinute: "asc" },
      });
      assert.equal(savedAvailability?.openingMinute, 540);
      assert.equal(savedAvailability?.closingMinute, 1020);

      const date = tomorrowInTimeZone(timeZone);
      const customerActor = { id: customer.id, role: customer.role, active: customer.active };
      const firstBookingId = await prisma.$transaction(
        (tx) => createBookingRequest(tx, customerActor, business.id, serviceId!, date, 600, "First request"),
        { isolationLevel: "Serializable" },
      );
      bookingIds.push(firstBookingId);
      const persistedBooking = await prisma.booking.findUnique({ where: { id: firstBookingId } });
      assert.equal(persistedBooking?.status, BookingStatus.PENDING);
      assert.equal(persistedBooking?.priceCents, 5000);
      assert.equal(persistedBooking?.timezone, timeZone);
      const exceptionDate = addDays(date, 50).toISOString().slice(0, 10);
      await prisma.$transaction((tx) =>
        saveScheduleException(tx, provider, business.id, exceptionDate, true, []),
      );
      await expectWorkflowError(
        prisma.$transaction((tx) =>
          createBookingRequest(tx, customerActor, business.id, serviceId!, exceptionDate, 600, "Holiday"),
        ),
        "OUTSIDE_HOURS",
      );
      await prisma.booking.createMany({
        data: Array.from({ length: 105 }, (_, index) => ({
          customerId: customer.id,
          businessId: business.id,
          serviceId: serviceId!,
          date: addDays(date, Math.floor(index / 3)),
          timezone: timeZone,
          startMinute: 720 + (index % 3) * 30,
          durationMinutes: 30,
          priceCents: 5000,
          status: BookingStatus.PENDING,
        })),
      });
      const activeCount = await prisma.booking.count({
        where: { businessId: business.id, business: { ownerId: provider.id }, status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] } },
      });
      const lastBookingPage = await prisma.booking.findMany({
        where: { businessId: business.id, business: { ownerId: provider.id }, status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] } },
        orderBy: [{ date: "asc" }, { startMinute: "asc" }, { id: "asc" }],
        skip: 100,
        take: 25,
        select: { id: true },
      });
      assert.equal(activeCount, 106);
      assert.equal(lastBookingPage.length, 6, "the page after the first 100 active bookings remains reachable");
      await expectWorkflowError(
        prisma.$transaction((tx) =>
          createBookingRequest(tx, { id: provider.id, role: provider.role, active: true }, business.id, serviceId!, date, 720, "Provider cannot book"),
        ),
        "NOT_ALLOWED",
      );
      await expectWorkflowError(
        prisma.$transaction((tx) => saveAvailability(tx, customerActor, business.id, 2, [{ openingMinute: 540, closingMinute: 1020 }])),
        "NOT_ALLOWED",
      );
      await expectWorkflowError(
        prisma.$transaction(
          (tx) => createBookingRequest(tx, customerActor, business.id, serviceId!, date, 600, "Conflict"),
          { isolationLevel: "Serializable" },
        ),
        "CONFLICT",
      );

      const pendingSession = await prisma.session.create({
        data: { userId: provider.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) },
      });
      sessionId = pendingSession.id;
      await prisma.$transaction((tx) => setAccountActive(tx, admin.id, provider.id, false));
      const suspendedProvider = await prisma.user.findUniqueOrThrow({ where: { id: provider.id } });
      assert.equal(suspendedProvider.active, false);
      assert.equal(await prisma.session.findUnique({ where: { id: pendingSession.id } }), null);
      assert.equal(await prisma.business.count({
        where: { id: business.id, ...activePublicBusinessFilter() },
      }), 0, "suspended provider's approved listing is not public");
      await expectWorkflowError(
        prisma.$transaction((tx) => saveAvailability(tx, { ...provider, active: false }, business.id, 2, [{ openingMinute: 540, closingMinute: 1020 }])),
        "NOT_ALLOWED",
      );
      await expectWorkflowError(
        prisma.$transaction(
          (tx) => createBookingRequest(tx, customerActor, business.id, serviceId!, date, 720, "Unavailable"),
          { isolationLevel: "Serializable" },
        ),
        "UNAVAILABLE",
      );
      await expectWorkflowError(
        prisma.$transaction((tx) => setAccountActive(tx, provider.id, customer.id, false)),
        "NOT_ADMIN",
      );
      await prisma.$transaction((tx) => setAccountActive(tx, admin.id, provider.id, true));

      await prisma.booking.update({ where: { id: firstBookingId }, data: { status: BookingStatus.COMPLETED } });
      const review = await prisma.review.create({
        data: {
          bookingId: firstBookingId,
          businessId: business.id,
          authorId: customer.id,
          rating: 5,
          body: "Completed workflow review",
          status: ReviewStatus.PENDING,
        },
      });
      reviewId = review.id;
      await expectWorkflowError(
        prisma.$transaction((tx) => setReviewModeration(tx, customer.id, review.id, ReviewStatus.PUBLISHED)),
        "NOT_ADMIN",
      );
      await prisma.$transaction((tx) => setReviewModeration(tx, admin.id, review.id, ReviewStatus.PUBLISHED));
      assert.equal((await prisma.review.findUniqueOrThrow({ where: { id: review.id } })).status, ReviewStatus.PUBLISHED);

      const auditEvents = await prisma.auditLog.findMany({
        where: { actorId: { in: [customer.id, provider.id, admin.id] } },
        select: { action: true },
      });
      assert.ok(auditEvents.some((entry) => entry.action === "AVAILABILITY_UPDATED"));
      assert.ok(auditEvents.some((entry) => entry.action === "USER_SUSPENDED"));
      assert.ok(auditEvents.some((entry) => entry.action === "REVIEW_MODERATED"));
    } finally {
      if (adminId) await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
      if (customerId) await prisma.auditLog.deleteMany({ where: { actorId: customerId } });
      if (providerId) await prisma.auditLog.deleteMany({ where: { actorId: providerId } });
      if (reviewId) await prisma.review.deleteMany({ where: { id: reviewId } });
      if (businessId) await prisma.booking.deleteMany({ where: { businessId } });
      else if (bookingIds.length) await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
      if (businessId) {
        await prisma.availability.deleteMany({ where: { businessId } });
        await prisma.service.deleteMany({ where: { businessId } });
        await prisma.business.deleteMany({ where: { id: businessId } });
      }
      if (sessionId) await prisma.session.deleteMany({ where: { id: sessionId } });
      if (categoryId) await prisma.category.deleteMany({ where: { id: categoryId } });
      const userIds = [customerId, providerId, adminId, secondCustomerId].filter((id): id is string => Boolean(id));
      if (userIds.length) {
        await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
      await prisma.$disconnect();
    }
  },
);
