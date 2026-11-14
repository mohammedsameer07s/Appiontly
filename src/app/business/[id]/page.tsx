export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";

import { submitBooking } from "@/app/actions";
import BookingSlotPicker from "@/app/business/[id]/BookingSlotPicker";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getLocalDateAndMinute } from "@/lib/validation";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatMinute(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export default async function BusinessProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const [business, user, query] = await Promise.all([
    db.business.findUnique({
      where: { id },
      include: {
        owner: { select: { active: true } },
        category: { select: { name: true } },
        services: { where: { active: true }, orderBy: { name: "asc" } },
        availability: { orderBy: { weekday: "asc" } },
        reviews: {
          where: { status: "PUBLISHED" },
          select: { id: true, rating: true, body: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 20,
        },
      },
    }),
    getSessionUser(),
    searchParams,
  ]);
  if (!business) notFound();
  const canSeeUnapproved =
    user?.role === "ADMIN" || (user?.role === "PROVIDER" && user.id === business.ownerId);
  if ((!business.owner.active || business.status !== "APPROVED") && !canSeeUnapproved) notFound();
  const reviewAggregate = await db.review.aggregate({
    where: { businessId: business.id, status: "PUBLISHED" },
    _avg: { rating: true },
    _count: { _all: true },
  });
  const reviewCount = reviewAggregate._count._all;
  const average = reviewAggregate._avg.rating?.toFixed(1) ?? "No published ratings";
  const error = query?.error;
  const today = getLocalDateAndMinute(new Date(), business.timezone).date;
  const latestDate = new Date(`${today}T00:00:00.000Z`);
  latestDate.setUTCDate(latestDate.getUTCDate() + 90);
  const maxDate = latestDate.toISOString().slice(0, 10);

  return (
    <main className="businessProfile">
      <section className="businessHero">
        <div className="businessPoster" aria-hidden="true">{business.name.slice(0, 2).toUpperCase()}</div>
        <div>
          <span className="kicker">{business.category.name} · {business.status.toLowerCase()}</span>
          <h1 style={{ marginTop: "18px", fontSize: "2.5rem", letterSpacing: "-0.05em" }}>{business.name}</h1>
          <div className="businessMeta">
            <span>{average}{reviewCount ? ` (${reviewCount} verified)` : ""}</span>
            <span>{business.city}</span>
            <span>{business.address}</span>
          </div>
          <p style={{ marginTop: "18px", color: "#475569", lineHeight: 1.8 }}>{business.description}</p>
          <div className="businessMeta"><strong>Local time zone: {business.timezone}</strong></div>
          <h2 style={{ marginTop: "24px" }}>Services</h2>
          <div className="serviceList">
            {business.services.length ? business.services.map((service) => (
              <article className="serviceItem" key={service.id}>
                <div><h3>{service.name}</h3><p>{service.description || "Service details provided by the business."}</p></div>
                <strong>₹{(service.priceCents / 100).toFixed(2)} · {service.durationMinutes} min</strong>
              </article>
            )) : <p>No services are currently available.</p>}
          </div>
        </div>
      </section>

      <section className="bookingPanel">
        <h2>Opening hours</h2>
        <p>Times are shown in {business.timezone}.</p>
        <ul className="availabilityList">
          {business.availability.map((window) => (
            <li key={window.id}><span>{weekdays[window.weekday]}</span><strong>{formatMinute(window.openingMinute)}–{formatMinute(window.closingMinute)}</strong></li>
          ))}
          {!business.availability.length ? <li>No opening hours are listed.</li> : null}
        </ul>
      </section>

      <section className="bookingPanel">
        <h2>Request an appointment</h2>
        {error ? <p role="alert" style={{ color: "#b91c1c", margin: "12px 0" }}>{error}</p> : null}
        {business.status !== "APPROVED" || !business.owner.active ? (
          <p>This listing is not currently available for booking.</p>
        ) : !user ? (
          <p style={{ marginTop: "14px", color: "#475569" }}>
            Please <Link className="inlineLink" href="/login">sign in</Link> as a customer to request a time.
          </p>
        ) : user.role === "CUSTOMER" && business.services.length ? (
          <form action={submitBooking}>
            <input type="hidden" name="businessId" value={business.id} />
            <BookingSlotPicker
              businessId={business.id}
              timezone={business.timezone}
              services={business.services}
              minDate={today}
              maxDate={maxDate}
            />
            <label>Notes<textarea name="details" maxLength={500} placeholder="Optional details for the provider" /></label>
            <div className="formActions"><button type="submit">Request booking</button></div>
            <p className="formHint">A request is not a payment or a confirmation. The provider will update its status.</p>
          </form>
        ) : (
          <p>Only customer accounts can request a booking. <Link className="inlineLink" href="/register">Create a customer account</Link>.</p>
        )}
      </section>

      <section className="bookingPanel">
        <h2>Published reviews</h2>
        {business.reviews.length ? business.reviews.map((review) => (
          <article className="reviewItem" key={review.id}>
            <strong>{review.rating} / 5 · Verified completed booking</strong>
            <p>{review.body}</p>
            <small>{review.createdAt.toLocaleDateString()}</small>
          </article>
        )) : <p>No reviews have been published for this business.</p>}
        {reviewCount > business.reviews.length ? <p className="formHint">Showing the most recent {business.reviews.length} of {reviewCount} published reviews.</p> : null}
      </section>
    </main>
  );
}
