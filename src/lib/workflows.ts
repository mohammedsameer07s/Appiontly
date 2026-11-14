import {
  BookingStatus,
  BusinessStatus,
  Prisma,
  ReviewStatus,
  UserRole,
} from "@appointly/prisma-client";

import { canChangeAccountAccess } from "@/lib/authorization";
import { areTimeWindowsValid, hasActiveSlotConflict, type TimeWindow } from "@/lib/booking-rules";
import {
  getLocalDateAndMinute,
  getWeekday,
  isFutureLocalAppointment,
  isValidBookingDate,
  isValidCalendarDate,
  isValidLocalAppointmentTime,
} from "@/lib/validation";
import { enqueueBookingUpdate } from "@/lib/notifications";

function assertAdmin(actor: { role: UserRole; active: boolean }) {
  if (!actor.active || actor.role !== UserRole.ADMIN) throw new Error("NOT_ADMIN");
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

export async function createBookingRequest(
  tx: Prisma.TransactionClient,
  actor: { id: string; role: UserRole; active: boolean },
  businessId: string,
  serviceId: string,
  date: string,
  startMinute: number,
  details: string,
  existingBookingId?: string,
) {
  if (!actor.active || actor.role !== UserRole.CUSTOMER) throw new Error("NOT_ALLOWED");
  const business = await tx.business.findUnique({
    where: { id: businessId },
    include: {
      availability: true,
      scheduleExceptions: {
        where: { date: new Date(`${date}T00:00:00.000Z`) },
        include: { shifts: true },
      },
      owner: { select: { active: true } },
    },
  });
  const service = await tx.service.findFirst({ where: { id: serviceId, businessId, active: true } });
  if (!business || !business.owner.active || business.status !== BusinessStatus.APPROVED || !service) {
    throw new Error("UNAVAILABLE");
  }
  if (!isValidBookingDate(date, new Date(), business.timezone)) throw new Error("INVALID_DATE");
  if (!isValidLocalAppointmentTime(date, startMinute, business.timezone)) throw new Error("INVALID_LOCAL_TIME");
  const currentBooking = existingBookingId
    ? await tx.booking.findFirst({ where: { id: existingBookingId, customerId: actor.id } })
    : null;
  if (
    existingBookingId &&
    (!currentBooking ||
      currentBooking.status === BookingStatus.COMPLETED ||
      currentBooking.status === BookingStatus.CANCELLED ||
      !isFutureLocalAppointment(
        currentBooking.date.toISOString().slice(0, 10),
        currentBooking.startMinute,
        currentBooking.timezone,
      ))
  ) {
    throw new Error("NOT_ALLOWED");
  }
  const durationMinutes = currentBooking?.durationMinutes ?? service.durationMinutes;
  const slot = { date, startMinute, durationMinutes };
  const exception = business.scheduleExceptions[0];
  const dateWindows = exception
    ? exception.isClosed
      ? []
      : exception.shifts
    : business.availability.filter((window) => window.weekday === getWeekday(date));
  if (!dateWindows.some((window) => startMinute >= window.openingMinute && startMinute + durationMinutes <= window.closingMinute)) {
    throw new Error("OUTSIDE_HOURS");
  }
  if (!isFutureLocalAppointment(date, startMinute, business.timezone)) throw new Error("PAST");

  const existing = await tx.booking.findMany({
    where: {
      businessId,
      date: new Date(`${date}T00:00:00.000Z`),
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      ...(existingBookingId ? { id: { not: existingBookingId } } : {}),
    },
    select: { startMinute: true, durationMinutes: true, status: true },
  });
  if (hasActiveSlotConflict(slot, existing)) throw new Error("CONFLICT");

  const data = {
    businessId,
    serviceId,
    date: new Date(`${date}T00:00:00.000Z`),
    timezone: business.timezone,
    startMinute,
    durationMinutes,
    priceCents: currentBooking?.priceCents ?? service.priceCents,
    details,
    status: BookingStatus.PENDING,
  };
  if (existingBookingId) {
    const payment = await tx.payment.findUnique({
      where: { bookingId: existingBookingId },
      select: { id: true },
    });
    if (payment) {
      throw new Error("PAYMENT_REQUIRES_SUPPORT");
    }
    await tx.booking.update({ where: { id: existingBookingId }, data });
    await enqueueBookingUpdate(tx, existingBookingId, BookingStatus.PENDING);
    await writeAudit(tx, actor.id, "BOOKING_RESCHEDULED", "Booking", existingBookingId);
    return existingBookingId;
  }

  const booking = await tx.booking.create({ data: { ...data, customerId: actor.id } });
  await enqueueBookingUpdate(tx, booking.id, BookingStatus.PENDING);
  await writeAudit(tx, actor.id, "BOOKING_CREATED", "Booking", booking.id);
  return booking.id;
}

export async function saveAvailability(
  tx: Prisma.TransactionClient,
  actor: { id: string; role: UserRole; active: boolean },
  businessId: string,
  weekday: number,
  windows: TimeWindow[],
) {
  if (!actor.active || actor.role !== UserRole.PROVIDER || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new Error("NOT_ALLOWED");
  }
  const business = await tx.business.findUnique({
    where: { id: businessId },
    select: { id: true, ownerId: true, owner: { select: { active: true } } },
  });
  if (!business || business.ownerId !== actor.id || !business.owner.active) throw new Error("NOT_ALLOWED");

  if (!areTimeWindowsValid(windows)) throw new Error("INVALID_AVAILABILITY");
  const bookings = await tx.booking.findMany({
    where: { businessId, status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] } },
    select: { date: true, startMinute: true, durationMinutes: true },
  });
  const relevantBookings = bookings.filter((booking) => getWeekday(booking.date.toISOString().slice(0, 10)) === weekday);
  const exceptions = relevantBookings.length
    ? await tx.scheduleException.findMany({
        where: {
          businessId,
          date: { in: relevantBookings.map((booking) => booking.date) },
        },
        select: { date: true },
      })
    : [];
  const exceptionDates = new Set(exceptions.map((exception) => exception.date.toISOString().slice(0, 10)));
  if (relevantBookings.some((booking) => {
    if (exceptionDates.has(booking.date.toISOString().slice(0, 10))) return false;
    return !windows.some((window) =>
      booking.startMinute >= window.openingMinute &&
      booking.startMinute + booking.durationMinutes <= window.closingMinute,
    );
  })) {
    throw new Error("SCHEDULE_CONFLICT");
  }
  await tx.availability.deleteMany({ where: { businessId, weekday } });
  if (windows.length) {
    await tx.availability.createMany({
      data: windows.map(({ openingMinute, closingMinute }) => ({ businessId, weekday, openingMinute, closingMinute })),
    });
  }
  await writeAudit(tx, actor.id, windows.length ? "AVAILABILITY_UPDATED" : "AVAILABILITY_REMOVED", "Availability", `${businessId}:${weekday}`, {
    weekday,
    windows,
  });
}

export async function saveScheduleException(
  tx: Prisma.TransactionClient,
  actor: { id: string; role: UserRole; active: boolean },
  businessId: string,
  date: string,
  isClosed: boolean,
  windows: TimeWindow[],
) {
  if (!actor.active || actor.role !== UserRole.PROVIDER || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("NOT_ALLOWED");
  }
  const business = await tx.business.findUnique({
    where: { id: businessId },
    select: { id: true, ownerId: true, timezone: true, owner: { select: { active: true } } },
  });
  if (!business || business.ownerId !== actor.id || !business.owner.active) throw new Error("NOT_ALLOWED");
  if (
    !isValidCalendarDate(date) ||
    date < getLocalDateAndMinute(new Date(), business.timezone).date ||
    date > latestExceptionDate(business.timezone)
  ) {
    throw new Error("INVALID_EXCEPTION_DATE");
  }
  if ((isClosed && windows.length > 0) || (!isClosed && !windows.length) || !areTimeWindowsValid(windows)) {
    throw new Error("INVALID_AVAILABILITY");
  }
  const existingBookings = await tx.booking.findMany({
    where: {
      businessId,
      date: new Date(`${date}T00:00:00.000Z`),
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
    },
    select: { startMinute: true, durationMinutes: true },
  });
  if (existingBookings.some((booking) =>
    isClosed ||
    !windows.some((window) =>
      booking.startMinute >= window.openingMinute &&
      booking.startMinute + booking.durationMinutes <= window.closingMinute,
    ),
  )) {
    throw new Error("SCHEDULE_CONFLICT");
  }

  const exception = await tx.scheduleException.upsert({
    where: { businessId_date: { businessId, date: new Date(`${date}T00:00:00.000Z`) } },
    create: { businessId, date: new Date(`${date}T00:00:00.000Z`), isClosed },
    update: { isClosed },
  });
  await tx.scheduleExceptionShift.deleteMany({ where: { exceptionId: exception.id } });
  if (windows.length) {
    await tx.scheduleExceptionShift.createMany({
      data: windows.map(({ openingMinute, closingMinute }) => ({
        exceptionId: exception.id,
        openingMinute,
        closingMinute,
      })),
    });
  }
  await writeAudit(tx, actor.id, "SCHEDULE_EXCEPTION_SAVED", "ScheduleException", exception.id, {
    date,
    isClosed,
    windows,
  });
}

export async function removeScheduleException(
  tx: Prisma.TransactionClient,
  actor: { id: string; role: UserRole; active: boolean },
  businessId: string,
  exceptionId: string,
) {
  if (!actor.active || actor.role !== UserRole.PROVIDER) throw new Error("NOT_ALLOWED");
  const exception = await tx.scheduleException.findFirst({
    where: { id: exceptionId, businessId, business: { ownerId: actor.id, owner: { active: true } } },
    select: { id: true },
  });
  if (!exception) throw new Error("NOT_ALLOWED");
  await tx.scheduleException.delete({ where: { id: exception.id } });
  await writeAudit(tx, actor.id, "SCHEDULE_EXCEPTION_REMOVED", "ScheduleException", exception.id);
}

function latestExceptionDate(timeZone: string) {
  const date = new Date(`${getLocalDateAndMinute(new Date(), timeZone).date}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 365);
  return date.toISOString().slice(0, 10);
}

export async function setAccountActive(
  tx: Prisma.TransactionClient,
  actorId: string,
  targetUserId: string,
  active: boolean,
) {
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, active: true } });
  if (!actor) throw new Error("NOT_ADMIN");
  assertAdmin(actor);
  const target = await tx.user.findUnique({ where: { id: targetUserId }, select: { id: true, role: true } });
  if (!target || !canChangeAccountAccess(actor.role, target.role, targetUserId === actorId, active)) {
    throw new Error("NOT_ALLOWED");
  }
  await tx.user.update({ where: { id: targetUserId }, data: { active } });
  if (!active) await tx.session.deleteMany({ where: { userId: targetUserId } });
  await writeAudit(tx, actorId, active ? "USER_REACTIVATED" : "USER_SUSPENDED", "User", targetUserId);
}

export async function setReviewModeration(
  tx: Prisma.TransactionClient,
  actorId: string,
  reviewId: string,
  status: ReviewStatus,
) {
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, active: true } });
  if (!actor) throw new Error("NOT_ADMIN");
  assertAdmin(actor);
  const review = await tx.review.findUnique({ where: { id: reviewId }, select: { id: true } });
  if (!review) throw new Error("NOT_FOUND");
  await tx.review.update({ where: { id: reviewId }, data: { status } });
  await writeAudit(tx, actorId, "REVIEW_MODERATED", "Review", reviewId, { status });
}

export function activePublicBusinessFilter() {
  return { status: BusinessStatus.APPROVED, owner: { active: true } } satisfies Prisma.BusinessWhereInput;
}
