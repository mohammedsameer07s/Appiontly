import { hasActiveSlotConflict, type ExistingSlot, type TimeWindow } from "@/lib/booking-rules";
import { isFutureLocalAppointment, isValidLocalAppointmentTime } from "@/lib/validation";

export function getAvailableStartMinutes(
  date: string,
  timezone: string,
  durationMinutes: number,
  windows: TimeWindow[],
  existing: ExistingSlot[],
  now = new Date(),
) {
  const starts = new Set<number>();
  for (const window of windows) {
    const firstStart = Math.ceil(window.openingMinute / 15) * 15;
    for (let startMinute = firstStart; startMinute + durationMinutes <= window.closingMinute; startMinute += 15) {
      if (
        isFutureLocalAppointment(date, startMinute, timezone, now) &&
        isValidLocalAppointmentTime(date, startMinute, timezone) &&
        !hasActiveSlotConflict({ date, startMinute, durationMinutes }, existing)
      ) {
        starts.add(startMinute);
      }
    }
  }
  return [...starts].sort((a, b) => a - b);
}

export function formatMinuteOfDay(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
