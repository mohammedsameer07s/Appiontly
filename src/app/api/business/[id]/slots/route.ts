import { BookingStatus, BusinessStatus, UserRole } from "@appointly/prisma-client";

import { db } from "@/lib/db";
import { getAvailableStartMinutes, formatMinuteOfDay } from "@/lib/availability";
import { getWeekday, isValidBookingDate, isValidCalendarDate } from "@/lib/validation";
import { getSessionUser } from "@/lib/session";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const query = new URL(request.url).searchParams;
  const serviceId = query.get("serviceId") ?? "";
  const date = query.get("date") ?? "";
  const bookingId = query.get("bookingId") ?? "";
  if (!serviceId || !isValidCalendarDate(date)) {
    return Response.json({ error: "Choose a valid service and date within 90 days." }, { status: 400 });
  }

  const [business, user] = await Promise.all([
    db.business.findFirst({
      where: { id, status: BusinessStatus.APPROVED, owner: { active: true } },
      include: {
        availability: true,
        scheduleExceptions: {
          where: { date: new Date(`${date}T00:00:00.000Z`) },
          include: { shifts: true },
        },
      },
    }),
    getSessionUser(),
  ]);
  if (!business) return Response.json({ error: "Business not found." }, { status: 404 });
  if (!isValidBookingDate(date, new Date(), business.timezone)) {
    return Response.json({ error: "Choose a valid date within the next 90 days." }, { status: 400 });
  }

  const service = await db.service.findFirst({
    where: { id: serviceId, businessId: business.id, active: true },
    select: { durationMinutes: true },
  });
  if (!service) return Response.json({ error: "Service not found." }, { status: 404 });

  let excludedBookingId: string | undefined;
  if (bookingId) {
    if (!user || user.role !== UserRole.CUSTOMER) {
      return Response.json({ error: "Sign in to reschedule a booking." }, { status: 401 });
    }
    const booking = await db.booking.findFirst({
      where: {
        id: bookingId,
        customerId: user.id,
        businessId: business.id,
        serviceId,
        status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      },
      select: { id: true },
    });
    if (!booking) return Response.json({ error: "Booking not found." }, { status: 404 });
    excludedBookingId = booking.id;
  }

  const exception = business.scheduleExceptions[0];
  const windows = exception
    ? exception.isClosed
      ? []
      : exception.shifts
    : business.availability.filter((window) => window.weekday === getWeekday(date));
  const existing = await db.booking.findMany({
    where: {
      businessId: business.id,
      date: new Date(`${date}T00:00:00.000Z`),
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      ...(excludedBookingId ? { id: { not: excludedBookingId } } : {}),
    },
    select: { startMinute: true, durationMinutes: true, status: true },
  });
  const slots = getAvailableStartMinutes(date, business.timezone, service.durationMinutes, windows, existing);
  return Response.json({ timezone: business.timezone, slots: slots.map(formatMinuteOfDay) });
}
