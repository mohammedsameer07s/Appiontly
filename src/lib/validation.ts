export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function isValidPhone(value: string) {
  return /^\+?[0-9\s().-]{10,20}$/.test(value) && value.replace(/\D/g, "").length >= 10;
}

export function isE164Phone(value: string) {
  const normalized = value.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(normalized);
}

export function isStrongPassword(value: string) {
  return value.length >= 12 && Buffer.byteLength(value, "utf8") <= 72;
}

export function sanitizeText(value: string, maxLength = 200) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function parseMinuteOfDay(value: string) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function parseMoneyToCents(value: string) {
  const normalized = value.trim();
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

export function isValidCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isValidBookingDate(value: string, now = new Date(), timeZone = "UTC") {
  if (!isValidCalendarDate(value)) return false;
  const today = getLocalDateAndMinute(now, timeZone).date;
  const latest = new Date(`${today}T00:00:00.000Z`);
  latest.setUTCDate(latest.getUTCDate() + 90);
  return value >= today && value <= latest.toISOString().slice(0, 10);
}

export function getWeekday(date: string) {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

export function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function getLocalDateAndMinute(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minute: Number(values.hour) * 60 + Number(values.minute),
  };
}

export function isFutureLocalAppointment(date: string, startMinute: number, timeZone: string, now = new Date()) {
  const localNow = getLocalDateAndMinute(now, timeZone);
  return date > localNow.date || (date === localNow.date && startMinute > localNow.minute);
}

export function isValidLocalAppointmentTime(date: string, minute: number, timeZone: string) {
  if (!isValidTimeZone(timeZone) || !isValidCalendarDate(date)) {
    return false;
  }
  if (!Number.isInteger(minute) || minute < 0 || minute >= 1440) return false;
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60);
  const offsets = new Set<number>();
  for (const delta of [-36, 0, 36]) {
    const instant = new Date(target + delta * 60 * 60 * 1000);
    const local = getLocalDateAndMinute(instant, timeZone);
    const [localYear, localMonth, localDay] = local.date.split("-").map(Number);
    offsets.add((Date.UTC(localYear, localMonth - 1, localDay, Math.floor(local.minute / 60), local.minute % 60) - instant.getTime()) / 60000);
  }

  let matches = 0;
  for (const offset of offsets) {
    const instant = new Date(target - offset * 60000);
    const local = getLocalDateAndMinute(instant, timeZone);
    if (local.date === date && local.minute === minute) matches += 1;
  }
  return matches === 1;
}

export function getLocalAppointmentInstant(date: string, minute: number, timeZone: string) {
  if (!isValidCalendarDate(date) || !isValidTimeZone(timeZone) || !Number.isInteger(minute) || minute < 0 || minute >= 1440) {
    return null;
  }
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60);
  const offsets = new Set<number>();
  for (const delta of [-36, 0, 36]) {
    const instant = new Date(target + delta * 60 * 60 * 1000);
    const local = getLocalDateAndMinute(instant, timeZone);
    const [localYear, localMonth, localDay] = local.date.split("-").map(Number);
    offsets.add(
      (Date.UTC(localYear, localMonth - 1, localDay, Math.floor(local.minute / 60), local.minute % 60) -
        instant.getTime()) /
        60000,
    );
  }
  for (const offset of offsets) {
    const instant = new Date(target - offset * 60000);
    const local = getLocalDateAndMinute(instant, timeZone);
    if (local.date === date && local.minute === minute) return instant;
  }
  return null;
}
