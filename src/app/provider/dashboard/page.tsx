export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";

import {
  createService,
  removeBusinessScheduleException,
  requestEmailVerification,
  saveBusinessScheduleException,
  setAvailability,
  setProviderBookingStatus,
  updateBusiness,
  updateService,
} from "@/app/actions";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const bookingPageSize = 25;

type ProviderParams = Record<string, string | string[] | undefined>;

function firstParam(params: ProviderParams, name: string) {
  const value = params[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

function bookingPage(params: ProviderParams, businessId: string, total: number) {
  const requested = Number(firstParam(params, `bookings_${businessId}_page`));
  const pageCount = Math.max(1, Math.ceil(total / bookingPageSize));
  const page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, pageCount) : 1;
  return { page, pageCount };
}

function bookingNavigation(
  params: ProviderParams,
  businessId: string,
  page: number,
  pageCount: number,
  total: number,
) {
  const hrefFor = (target: number) => {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) {
        for (const entry of Array.isArray(value) ? value : [value]) query.append(name, entry);
      }
    }
    query.set(`bookings_${businessId}_page`, String(target));
    return `/provider/dashboard?${query.toString()}#bookings-${businessId}`;
  };
  const first = total ? (page - 1) * bookingPageSize + 1 : 0;
  const last = Math.min(page * bookingPageSize, total);

  return (
    <nav aria-label={`${businessId} booking pages`} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px", margin: "12px 0" }}>
      <span>Showing {first}–{last} of {total} active requests</span>
      {page > 1 ? <Link href={hrefFor(page - 1)}>Previous requests</Link> : <span aria-disabled="true">Previous requests</span>}
      <span>Page {page} of {pageCount}</span>
      {page < pageCount ? <Link href={hrefFor(page + 1)}>Next requests</Link> : <span aria-disabled="true">Next requests</span>}
    </nav>
  );
}

function formatMinute(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function formatWindows(windows: Array<{ openingMinute: number; closingMinute: number }>) {
  return windows.map((window) => `${formatMinute(window.openingMinute)}-${formatMinute(window.closingMinute)}`).join(", ");
}

export default async function ProviderDashboardPage({
  searchParams,
}: {
  searchParams?: Promise<ProviderParams>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "PROVIDER") redirect("/");
  const params = (await searchParams) ?? {};
  const [businessesWithCounts, categories, pendingCount] = await Promise.all([
    db.business.findMany({
      where: { ownerId: user.id },
      include: {
        category: { select: { name: true } },
        services: { orderBy: { name: "asc" } },
        availability: { orderBy: { weekday: "asc" } },
        scheduleExceptions: {
          where: { date: { gte: new Date(new Date().toISOString().slice(0, 10)) } },
          include: { shifts: { orderBy: { openingMinute: "asc" } } },
          orderBy: { date: "asc" },
          take: 30,
        },
        _count: { select: { bookings: { where: { status: { in: ["PENDING", "CONFIRMED"] } } } } },
      },
    }),
    db.category.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    db.booking.count({
      where: { business: { ownerId: user.id }, status: { in: ["PENDING", "CONFIRMED"] } },
    }),
  ]);
  const businesses = await Promise.all(businessesWithCounts.map(async (business) => {
    const pagination = bookingPage(params, business.id, business._count.bookings);
    const bookings = await db.booking.findMany({
      where: {
        businessId: business.id,
        business: { ownerId: user.id },
        status: { in: ["PENDING", "CONFIRMED"] },
      },
      include: { service: { select: { name: true } } },
      orderBy: [{ date: "asc" }, { startMinute: "asc" }, { id: "asc" }],
      skip: (pagination.page - 1) * bookingPageSize,
      take: bookingPageSize,
    });
    return { ...business, bookings, bookingPagination: pagination };
  }));
  const approvedCount = businesses.filter((business) => business.status === "APPROVED").length;

  return (
    <main className="pageBox">
      <div className="summaryCard">
        <h1>Provider dashboard</h1>
        <p>Manage your business, listed services, weekly opening hours, and appointment requests.</p>
        {params.error ? <p role="alert" style={{ color: "#b91c1c", marginTop: "12px" }}>{params.error}</p> : null}
        {params.message ? <p role="status" style={{ color: "#065f46", marginTop: "12px" }}>{params.message}</p> : null}
        {!user.emailVerifiedAt ? (
          <form action={requestEmailVerification} className="inlineForm">
            <p role="status">Verify your email address to receive account and booking updates.</p>
            <button type="submit" className="manageButton">Send verification email</button>
          </form>
        ) : null}
        <div className="summaryGrid" style={{ marginTop: "18px" }}>
          <div className="summaryItem"><strong>{businesses.length}</strong>your businesses</div>
          <div className="summaryItem"><strong>{approvedCount}</strong>approved listings</div>
          <div className="summaryItem"><strong>{pendingCount}</strong>active requests</div>
        </div>
      </div>

      {businesses.length ? businesses.map((business) => (
        <section className="tableCard" key={business.id}>
          <div className="dashboardHeading">
            <div><h2>{business.name}</h2><p>{business.category.name} · {business.city}</p></div>
            <span className={`badge ${business.status === "APPROVED" ? "badgeSuccess" : "badgePending"}`}>{business.status}</span>
          </div>
          <p>Listing changes to an approved profile are sent back for review. Times are local to {business.timezone}.</p>

          <h3>Business details</h3>
          <form action={updateBusiness}>
            <input type="hidden" name="businessId" value={business.id} />
            <div className="formGrid">
              <label>Business name<input name="name" defaultValue={business.name} maxLength={120} required /></label>
              <label>Category<select name="categoryId" defaultValue={business.categoryId} required>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
              <label>City<input name="city" defaultValue={business.city} maxLength={80} required /></label>
              <label>Latitude<input name="latitude" type="number" min="-90" max="90" step="any" defaultValue={business.latitude ?? ""} /></label>
              <label>Longitude<input name="longitude" type="number" min="-180" max="180" step="any" defaultValue={business.longitude ?? ""} /></label>
              <label>Time zone<input name="timezone" defaultValue={business.timezone} maxLength={80} required /></label>
              <label className="fullWidth">Address<input name="address" defaultValue={business.address} maxLength={180} required /></label>
              <label className="fullWidth">Description<textarea name="description" defaultValue={business.description} maxLength={1000} rows={4} required /></label>
            </div>
            <div className="formActions"><button type="submit">Save business details</button><Link href={`/business/${business.id}`} className="inlineLink">View listing</Link></div>
          </form>

          <h3 className="sectionGap">Services and prices (INR)</h3>
          <div className="providerServiceGrid">
            {business.services.map((service) => (
              <form className="serviceManageCard" action={updateService} key={service.id}>
                <input type="hidden" name="serviceId" value={service.id} />
                <label>Service name<input name="name" defaultValue={service.name} maxLength={100} required /></label>
                <label>Price (INR)<input name="price" type="number" min="0" max="9999999" step="0.01" defaultValue={(service.priceCents / 100).toFixed(2)} required /></label>
                <label>Duration (minutes)<input name="durationMinutes" type="number" min="5" max="480" step="5" defaultValue={service.durationMinutes} required /></label>
                <label>Description<input name="description" defaultValue={service.description} maxLength={500} /></label>
                <label className="checkboxLabel"><input name="active" type="checkbox" defaultChecked={service.active} /> Available for new bookings</label>
                <button type="submit" className="manageButton">Save service</button>
              </form>
            ))}
          </div>
          <form action={createService} className="inlineForm">
            <input type="hidden" name="businessId" value={business.id} />
            <h4>Add a service</h4>
            <div className="formGrid">
              <label>Service name<input name="name" maxLength={100} required /></label>
              <label>Price (INR)<input name="price" type="number" min="0" max="9999999" step="0.01" required /></label>
              <label>Duration (minutes)<input name="durationMinutes" type="number" min="5" max="480" step="5" defaultValue="30" required /></label>
              <label>Description<input name="description" maxLength={500} /></label>
            </div>
            <button type="submit" className="manageButton">Add service</button>
          </form>

          <h3 className="sectionGap">Weekly availability</h3>
          <div className="availabilityManageGrid">
            {weekdays.map((day, weekday) => {
              const windows = business.availability.filter((entry) => entry.weekday === weekday);
              return (
                <form action={setAvailability} className="availabilityManageItem" key={day}>
                  <input type="hidden" name="businessId" value={business.id} />
                  <input type="hidden" name="weekday" value={weekday} />
                  <strong>{day}</strong>
                  <label className="fullWidth">Hours<input name="windows" defaultValue={formatWindows(windows)} placeholder="09:00-12:00, 13:00-17:00" maxLength={80} /></label>
                  <button type="submit" className="manageButton">Save hours</button>
                </form>
              );
            })}
          </div>

          <h3 className="sectionGap">Date-specific hours and holidays</h3>
          <p>These exceptions override the weekly hours for one date and can be set up to 365 days ahead.</p>
          <form action={saveBusinessScheduleException} className="inlineForm">
            <input type="hidden" name="businessId" value={business.id} />
            <div className="formGrid">
              <label>Date<input type="date" name="date" required /></label>
              <label>Special hours<input name="windows" placeholder="09:00-12:00, 13:00-17:00" maxLength={80} /></label>
              <label className="checkboxLabel"><input name="isClosed" type="checkbox" /> Closed all day</label>
            </div>
            <button type="submit" className="manageButton">Save date exception</button>
          </form>
          {business.scheduleExceptions.length ? (
            <div className="tableWrap"><table>
              <thead><tr><th>Date</th><th>Hours</th><th>Action</th></tr></thead>
              <tbody>{business.scheduleExceptions.map((exception) => (
                <tr key={exception.id}>
                  <td>{exception.date.toISOString().slice(0, 10)}</td>
                  <td>{exception.isClosed ? "Closed" : formatWindows(exception.shifts)}</td>
                  <td><form action={removeBusinessScheduleException}>
                    <input type="hidden" name="businessId" value={business.id} />
                    <input type="hidden" name="exceptionId" value={exception.id} />
                    <button className="secondaryAction" type="submit">Remove</button>
                  </form></td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <p>No date-specific exceptions are scheduled.</p>}

          <h3 className="sectionGap" id={`bookings-${business.id}`}>Upcoming requests</h3>
          {bookingNavigation(
            params,
            business.id,
            business.bookingPagination.page,
            business.bookingPagination.pageCount,
            business._count.bookings,
          )}
          {business.bookings.length ? (
            <div className="tableWrap"><table>
              <thead><tr><th>Service</th><th>Date</th><th>Time</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>{business.bookings.map((booking) => (
                <tr key={booking.id}>
                  <td>{booking.service.name}</td>
                  <td>{booking.date.toISOString().slice(0, 10)}</td>
                  <td>{formatMinute(booking.startMinute)} · {booking.timezone}</td>
                  <td>{booking.status}</td>
                  <td><form action={setProviderBookingStatus} className="inlineStatusForm">
                    <input type="hidden" name="bookingId" value={booking.id} />
                    <select name="status" defaultValue="">
                      <option value="" disabled>Choose action</option>
                      {booking.status === "PENDING" ? <option value="CONFIRMED">Confirm</option> : null}
                      {booking.status === "CONFIRMED" ? <option value="COMPLETED">Complete</option> : null}
                      <option value="CANCELLED">Cancel</option>
                    </select>
                    <button className="reviewButton" type="submit">Update</button>
                  </form></td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <p>No pending or confirmed appointment requests.</p>}
        </section>
      )) : (
        <section className="tableCard"><h2>No business listings yet</h2><p>Submit your business profile for review to get started.</p><Link className="inlineLink" href="/provider/register">Register a business</Link></section>
      )}
    </main>
  );
}
