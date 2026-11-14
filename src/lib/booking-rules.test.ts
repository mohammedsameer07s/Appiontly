import assert from "node:assert/strict";
import test from "node:test";

import { areTimeWindowsValid, canTransitionBooking, hasActiveSlotConflict, isSlotWithinAvailability } from "./booking-rules";
import {
  getWeekday,
  isStrongPassword,
  isValidBookingDate,
  isValidLocalAppointmentTime,
  getLocalAppointmentInstant,
  parseMinuteOfDay,
  parseMoneyToCents,
} from "./validation";
import { getAvailableStartMinutes } from "./availability";
import { distanceInKilometers } from "./location";

test("validates availability boundaries and rejects out-of-hours slots", () => {
  const windows = [{ weekday: 1, openingMinute: 540, closingMinute: 1020 }];
  assert.equal(isSlotWithinAvailability({ date: "2026-11-09", startMinute: 990, durationMinutes: 30 }, 1, windows), true);
  assert.equal(isSlotWithinAvailability({ date: "2026-11-09", startMinute: 1000, durationMinutes: 30 }, 1, windows), false);
  assert.equal(isSlotWithinAvailability({ date: "2026-11-09", startMinute: 600, durationMinutes: 30 }, 2, windows), false);
});

test("computes available starts across shifts and respects active reservations", () => {
  const slots = getAvailableStartMinutes(
    "2026-11-16",
    "Asia/Kolkata",
    30,
    [
      { openingMinute: 540, closingMinute: 600 },
      { openingMinute: 660, closingMinute: 720 },
    ],
    [{ startMinute: 540, durationMinutes: 30, status: "CONFIRMED" }],
    new Date("2026-11-14T00:00:00Z"),
  );
  assert.deepEqual(slots, [570, 660, 675, 690]);
});

test("calculates appointment instants and great-circle distances", () => {
  assert.equal(getLocalAppointmentInstant("2026-03-08", 150, "America/New_York"), null);
  assert.equal(getLocalAppointmentInstant("2026-11-09", 570, "America/New_York")?.toISOString(), "2026-11-09T14:30:00.000Z");
  assert.ok(Math.abs(distanceInKilometers(0, 0, 0, 1) - 111.2) < 0.5);
});

test("accepts multiple non-overlapping shifts and rejects overlapping or invalid shifts", () => {
  assert.equal(areTimeWindowsValid([
    { openingMinute: 540, closingMinute: 720 },
    { openingMinute: 780, closingMinute: 1020 },
  ]), true);
  assert.equal(areTimeWindowsValid([
    { openingMinute: 540, closingMinute: 780 },
    { openingMinute: 720, closingMinute: 1020 },
  ]), false);
  assert.equal(areTimeWindowsValid([{ openingMinute: 1440, closingMinute: 1500 }]), false);
});

test("detects overlapping active reservations but allows cancelled slots", () => {
  const candidate = { date: "2026-11-09", startMinute: 600, durationMinutes: 60 };
  assert.equal(hasActiveSlotConflict(candidate, [{ startMinute: 630, durationMinutes: 30, status: "CONFIRMED" }]), true);
  assert.equal(hasActiveSlotConflict(candidate, [{ startMinute: 660, durationMinutes: 30, status: "PENDING" }]), false);
  assert.equal(hasActiveSlotConflict(candidate, [{ startMinute: 600, durationMinutes: 60, status: "CANCELLED" }]), false);
});

test("allows only valid booking state transitions", () => {
  assert.equal(canTransitionBooking("PENDING", "CONFIRMED"), true);
  assert.equal(canTransitionBooking("CONFIRMED", "COMPLETED"), true);
  assert.equal(canTransitionBooking("COMPLETED", "CONFIRMED"), false);
  assert.equal(canTransitionBooking("CANCELLED", "PENDING"), false);
});

test("validates password length, local dates, money, and time", () => {
  assert.equal(isStrongPassword("short"), false);
  assert.equal(isStrongPassword("correct-horse-42"), true);
  assert.equal(isStrongPassword("é".repeat(37)), false);
  assert.equal(isValidBookingDate("2026-02-30", new Date("2026-02-01T10:00:00Z")), false);
  assert.equal(isValidBookingDate("2026-02-02", new Date("2026-02-01T10:00:00Z")), true);
  assert.equal(parseMoneyToCents("29.90"), 2990);
  assert.equal(parseMoneyToCents("-1"), null);
  assert.equal(parseMinuteOfDay("09:30"), 570);
  assert.equal(parseMinuteOfDay("24:00"), null);
  assert.equal(getWeekday("2026-11-09"), 1);
  assert.equal(isValidLocalAppointmentTime("2026-03-08", 150, "America/New_York"), false);
  assert.equal(isValidLocalAppointmentTime("2026-11-01", 90, "America/New_York"), false);
  assert.equal(isValidLocalAppointmentTime("2026-11-09", 570, "America/New_York"), true);
});
