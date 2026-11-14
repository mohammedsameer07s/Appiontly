import type { BookingStatus } from "@appointly/prisma-client";

export type SlotCandidate = {
  date: string;
  startMinute: number;
  durationMinutes: number;
};

export type SlotAvailability = {
  weekday: number;
  openingMinute: number;
  closingMinute: number;
};

export type TimeWindow = {
  openingMinute: number;
  closingMinute: number;
};

export function areTimeWindowsValid(windows: TimeWindow[]) {
  if (windows.some(
    ({ openingMinute, closingMinute }) =>
      !Number.isInteger(openingMinute) ||
      !Number.isInteger(closingMinute) ||
      openingMinute < 0 ||
      closingMinute > 1440 ||
      openingMinute >= closingMinute,
  )) {
    return false;
  }
  const sorted = [...windows].sort((a, b) => a.openingMinute - b.openingMinute);
  return sorted.every((window, index) => index === 0 || sorted[index - 1].closingMinute <= window.openingMinute);
}

export type ExistingSlot = {
  startMinute: number;
  durationMinutes: number;
  status: BookingStatus;
};

export function isSlotWithinAvailability(
  candidate: SlotCandidate,
  weekday: number,
  windows: SlotAvailability[],
) {
  const endMinute = candidate.startMinute + candidate.durationMinutes;
  return windows.some(
    (window) =>
      window.weekday === weekday &&
      candidate.startMinute >= window.openingMinute &&
      endMinute <= window.closingMinute,
  );
}

export function hasActiveSlotConflict(candidate: SlotCandidate, existing: ExistingSlot[]) {
  const endMinute = candidate.startMinute + candidate.durationMinutes;
  return existing.some((slot) => {
    if (slot.status !== "PENDING" && slot.status !== "CONFIRMED") return false;
    const existingEnd = slot.startMinute + slot.durationMinutes;
    return candidate.startMinute < existingEnd && endMinute > slot.startMinute;
  });
}

export function canTransitionBooking(from: BookingStatus, to: BookingStatus) {
  const transitions: Record<BookingStatus, BookingStatus[]> = {
    PENDING: ["CONFIRMED", "CANCELLED"],
    CONFIRMED: ["COMPLETED", "CANCELLED"],
    COMPLETED: [],
    CANCELLED: [],
  };
  return transitions[from].includes(to);
}
