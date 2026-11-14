export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";

import {
  cancelBooking,
  requestEmailVerification,
  requestPhoneVerification,
  rescheduleBooking,
  startBookingPayment,
  submitReview,
} from "@/app/actions";
import { db } from "@/lib/db";
import { isFutureLocalAppointment } from "@/lib/validation";
import { getSessionUser } from "@/lib/session";

function formatMinute(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export default async function MyBookingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; message?: string; page?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "CUSTOMER") redirect("/");
  const params = (await searchParams) ?? {};
  const requestedPage = Number(params.page);
  const currentPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 1000) : 1;
  const pageSize = 50;
  const [bookingCount, bookings] = await Promise.all([
    db.booking.count({ where: { customerId: user.id } }),
    db.booking.findMany({
      where: { customerId: user.id },
      include: {
        business: { select: { id: true, name: true, timezone: true } },
        service: { select: { name: true } },
        review: { select: { status: true } },
        payment: { select: { status: true, paymentLinkUrl: true, lastRefundError: true } },
      },
      orderBy: [{ date: "desc" }, { startMinute: "desc" }],
      skip: (currentPage - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return (
    <main className="pageBox">
      <div className="summaryCard">
        <h1>My bookings</h1>
        <p>{bookingCount} total appointments. Review requests, change future bookings, and leave feedback after a completed appointment.</p>
        {params.error ? <p role="alert" style={{ color: "#b91c1c", marginTop: "12px" }}>{params.error}</p> : null}
        {params.message ? <p role="status" style={{ color: "#065f46", marginTop: "12px" }}>{params.message}</p> : null}
        {!user.emailVerifiedAt ? (
          <form action={requestEmailVerification} className="inlineForm">
            <p role="status">Verify your email before requesting a new appointment.</p>
            <button type="submit" className="manageButton">Send verification email</button>
          </form>
        ) : null}
        {user.smsNotificationsEnabled && !user.phoneVerifiedAt ? (
          <form action={requestPhoneVerification} className="inlineForm">
            <p>Verify your phone number for SMS booking updates.</p>
            <button type="submit" className="manageButton">Send phone verification code</button>
          </form>
        ) : null}
      </div>
      {bookings.length ? bookings.map((booking) => {
        const date = booking.date.toISOString().slice(0, 10);
        const canChange =
          (booking.status === "PENDING" || booking.status === "CONFIRMED") &&
          isFutureLocalAppointment(date, booking.startMinute, booking.timezone);
        return (
          <article className="bookingCard" key={booking.id}>
            <div className="dashboardHeading">
              <div><h2><Link href={`/business/${booking.business.id}`}>{booking.business.name}</Link></h2><p>{booking.service.name}</p></div>
              <span className="badge">{booking.status}</span>
            </div>
            <p>{date} at {formatMinute(booking.startMinute)} · {booking.durationMinutes} min · ₹{(booking.priceCents / 100).toFixed(2)} · {booking.timezone}</p>
            {booking.details ? <p>{booking.details}</p> : null}
            {booking.payment ? <p>Payment: {booking.payment.status.toLowerCase().replace("_", " ")}.</p> : null}
            {booking.payment?.status === "REFUND_PENDING" ? <p role="status">A refund is being processed. Contact support if it does not arrive within your bank&apos;s usual processing time.</p> : null}
            {booking.status === "CONFIRMED" && booking.payment?.status !== "PAID" ? (
              <form action={startBookingPayment}>
                <input type="hidden" name="bookingId" value={booking.id} />
                <button className="manageButton" type="submit">Pay online</button>
              </form>
            ) : null}
            {canChange ? (
              <div className="bookingActions">
                <form action={cancelBooking}><input type="hidden" name="bookingId" value={booking.id} /><button className="secondaryAction" type="submit">Cancel booking</button></form>
                {!booking.payment ? <form action={rescheduleBooking} className="rescheduleForm">
                  <input type="hidden" name="bookingId" value={booking.id} />
                  <label>New date<input type="date" name="date" required /></label>
                  <label>New time ({booking.business.timezone})<input type="time" name="time" step={300} required /></label>
                  <button className="manageButton" type="submit">Request reschedule</button>
                </form> : null}
              </div>
            ) : null}
            {booking.status === "COMPLETED" && !booking.review ? (
              <form action={submitReview} className="reviewForm">
                <input type="hidden" name="bookingId" value={booking.id} />
                <label>Rating<select name="rating" defaultValue="5"><option value="5">5 — Excellent</option><option value="4">4 — Good</option><option value="3">3 — Okay</option><option value="2">2 — Poor</option><option value="1">1 — Bad</option></select></label>
                <label>Review<textarea name="body" minLength={5} maxLength={1000} required /></label>
                <button className="manageButton" type="submit">Submit review</button>
              </form>
            ) : booking.review ? <p className="formHint">Review status: {booking.review.status.toLowerCase()}.</p> : null}
          </article>
        );
      }) : (
        <section className="tableCard"><p>No appointments yet. <Link href="/" className="inlineLink">Browse businesses</Link>.</p></section>
      )}
      {bookingCount > pageSize ? (
        <nav aria-label="Booking history pages" className="pagination">
          {currentPage > 1 ? <Link href={`/my-bookings?page=${currentPage - 1}`}>Previous</Link> : <span />}
          <span>Page {currentPage} of {Math.ceil(bookingCount / pageSize)}</span>
          {currentPage * pageSize < bookingCount ? <Link href={`/my-bookings?page=${currentPage + 1}`}>Next</Link> : <span />}
        </nav>
      ) : null}
    </main>
  );
}
