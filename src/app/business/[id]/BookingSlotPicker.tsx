"use client";

import { useEffect, useState } from "react";

type ServiceOption = {
  id: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
};

export default function BookingSlotPicker({
  businessId,
  timezone,
  services,
  minDate,
  maxDate,
  bookingId,
}: {
  businessId: string;
  timezone: string;
  services: ServiceOption[];
  minDate: string;
  maxDate: string;
  bookingId?: string;
}) {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [date, setDate] = useState("");
  const [slotResult, setSlotResult] = useState<{ key: string; slots: string[] } | null>(null);
  const [loadingKey, setLoadingKey] = useState("");
  const [slotError, setSlotError] = useState<{ key: string; error: string } | null>(null);
  const [selectedTime, setSelectedTime] = useState("");
  const key = `${serviceId}:${date}`;
  const slots = slotResult?.key === key ? slotResult.slots : [];
  const loading = loadingKey === key;
  const error = slotError?.key === key ? slotError.error : "";

  useEffect(() => {
    if (!serviceId || !date) return;

    const controller = new AbortController();
    const params = new URLSearchParams({ serviceId, date });
    if (bookingId) params.set("bookingId", bookingId);
    fetch(`/api/business/${encodeURIComponent(businessId)}/slots?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json() as { slots?: string[]; error?: string };
        if (!response.ok) throw new Error(result.error || "Could not load appointment times.");
        setSlotResult({ key, slots: result.slots ?? [] });
      })
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.name === "AbortError") return;
        setSlotError({ key, error: cause instanceof Error ? cause.message : "Could not load appointment times." });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingKey("");
      });

    return () => controller.abort();
  }, [businessId, bookingId, date, key, serviceId]);

  function changeService(value: string) {
    setServiceId(value);
    setSelectedTime("");
    setLoadingKey(`${value}:${date}`);
    setSlotError(null);
  }

  function changeDate(value: string) {
    setDate(value);
    setSelectedTime("");
    setLoadingKey(`${serviceId}:${value}`);
    setSlotError(null);
  }

  return (
    <>
      {services.length > 1 ? (
        <label>
          Service
          <select name="serviceId" value={serviceId} onChange={(event) => changeService(event.target.value)} required>
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name} — ₹{(service.priceCents / 100).toFixed(2)} ({service.durationMinutes} min)
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <input type="hidden" name="serviceId" value={serviceId} />
          {services[0] ? <p>{services[0].name} · {services[0].durationMinutes} min</p> : null}
        </>
      )}
      <div className="formGrid">
        <label>
          Appointment date
          <input
            name="date"
            type="date"
            min={minDate}
            max={maxDate}
            value={date}
            onChange={(event) => changeDate(event.target.value)}
            required
          />
        </label>
        <label>
          Available start time ({timezone})
          <select name="time" value={selectedTime} onChange={(event) => setSelectedTime(event.target.value)} required disabled={!date || loading || slots.length === 0}>
            <option value="" disabled>{loading ? "Loading available times…" : date ? "Choose an available time" : "Choose a date first"}</option>
            {slots.map((slot) => <option key={slot} value={slot}>{slot}</option>)}
          </select>
        </label>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {!loading && date && !error && slots.length === 0 ? <p>No available times for this date. Try another day.</p> : null}
    </>
  );
}
