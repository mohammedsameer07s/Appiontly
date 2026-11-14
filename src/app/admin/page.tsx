export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import Link from "next/link";
import { UserRole } from "@appointly/prisma-client";

import { createCategory, setBusinessStatus, setCategoryActive, setReviewStatus, setUserActive, setAdminBookingStatus } from "@/app/actions";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

function formatMinute(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

type AdminParams = Record<string, string | string[] | undefined>;

const pageSize = 25;

function param(params: AdminParams, name: string) {
  const value = params[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

function sectionState(params: AdminParams, section: string, total: number) {
  const search = param(params, `${section}Search`).slice(0, 100);
  const requested = Number(param(params, `${section}Page`));
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, pageCount) : 1;
  return { search, page, pageCount };
}

function listControls(
  params: AdminParams,
  section: string,
  search: string,
  page: number,
  pageCount: number,
  total: number,
) {
  const preserved = Object.entries(params).flatMap(([name, value]) => {
    if (name === `${section}Page` || name === `${section}Search` || name === "error" || name === "message") return [];
    return (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((entry) => (
      <input key={`${name}-${entry}`} type="hidden" name={name} value={entry} />
    ));
  });
  const hrefFor = (target: number) => {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && name !== "error" && name !== "message") {
        for (const entry of Array.isArray(value) ? value : [value]) query.append(name, entry);
      }
    }
    query.set(`${section}Search`, search);
    query.set(`${section}Page`, String(target));
    return `/admin?${query.toString()}#${section}`;
  };
  const first = total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(page * pageSize, total);

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "12px", margin: "16px 0" }}>
      <form method="get" action="/admin" style={{ display: "flex", flexWrap: "wrap", alignItems: "end", gap: "8px" }}>
        {preserved}
        <input type="hidden" name={`${section}Page`} value="1" />
        <label>
          Search
          <input name={`${section}Search`} defaultValue={search} maxLength={100} aria-label={`Search ${section}`} />
        </label>
        <button className="reviewButton" type="submit">Search</button>
      </form>
      <nav aria-label={`${section} pages`} style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <span>Showing {first}–{last} of {total}</span>
        {page > 1 ? <Link href={hrefFor(page - 1)}>Previous</Link> : <span aria-disabled="true">Previous</span>}
        <span>Page {page} of {pageCount}</span>
        {page < pageCount ? <Link href={hrefFor(page + 1)}>Next</Link> : <span aria-disabled="true">Next</span>}
      </nav>
    </div>
  );
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams?: Promise<AdminParams>;
}) {
  const user = await getSessionUser();
  if (!user || user.role !== "ADMIN") redirect("/");
  const params = (await searchParams) ?? {};
  const businessSearch = param(params, "businessesSearch").slice(0, 100);
  const bookingSearch = param(params, "bookingsSearch").slice(0, 100);
  const accountSearch = param(params, "accountsSearch").slice(0, 100);
  const reviewSearch = param(params, "reviewsSearch").slice(0, 100);
  const categorySearch = param(params, "categoriesSearch").slice(0, 100);
  const auditSearch = param(params, "auditSearch").slice(0, 100);
  const businessWhere = businessSearch ? {
    OR: [
      { name: { contains: businessSearch, mode: "insensitive" as const } },
      { city: { contains: businessSearch, mode: "insensitive" as const } },
      { owner: { is: { name: { contains: businessSearch, mode: "insensitive" as const } } } },
      { owner: { is: { email: { contains: businessSearch, mode: "insensitive" as const } } } },
      { category: { is: { name: { contains: businessSearch, mode: "insensitive" as const } } } },
    ],
  } : {};
  const bookingWhere = bookingSearch ? {
    OR: [
      { customer: { is: { name: { contains: bookingSearch, mode: "insensitive" as const } } } },
      { business: { is: { name: { contains: bookingSearch, mode: "insensitive" as const } } } },
      { service: { is: { name: { contains: bookingSearch, mode: "insensitive" as const } } } },
    ],
  } : {};
  const accountWhere = {
    role: { in: [UserRole.CUSTOMER, UserRole.PROVIDER] },
    ...(accountSearch ? { OR: [
      { name: { contains: accountSearch, mode: "insensitive" as const } },
      { email: { contains: accountSearch, mode: "insensitive" as const } },
    ] } : {}),
  };
  const reviewWhere = reviewSearch ? {
    OR: [
      { body: { contains: reviewSearch, mode: "insensitive" as const } },
      { business: { is: { name: { contains: reviewSearch, mode: "insensitive" as const } } } },
      { author: { is: { name: { contains: reviewSearch, mode: "insensitive" as const } } } },
    ],
  } : {};
  const categoryWhere = categorySearch ? { OR: [
    { name: { contains: categorySearch, mode: "insensitive" as const } },
    { slug: { contains: categorySearch, mode: "insensitive" as const } },
  ] } : {};
  const auditWhere = auditSearch ? {
    OR: [
      { action: { contains: auditSearch, mode: "insensitive" as const } },
      { targetType: { contains: auditSearch, mode: "insensitive" as const } },
      { targetId: { contains: auditSearch, mode: "insensitive" as const } },
      { actor: { is: { name: { contains: auditSearch, mode: "insensitive" as const } } } },
    ],
  } : {};
  const [businessCount, pendingCount, customerCount, businessTotal, bookingTotal, accountTotal, reviewTotal, categoryTotal, auditTotal] = await Promise.all([
    db.business.count(),
    db.business.count({ where: { status: "PENDING" } }),
    db.booking.count(),
    db.business.count({ where: businessWhere }),
    db.booking.count({ where: bookingWhere }),
    db.user.count({ where: accountWhere }),
    db.review.count({ where: reviewWhere }),
    db.category.count({ where: categoryWhere }),
    db.auditLog.count({ where: auditWhere }),
  ]);
  const businessesState = sectionState(params, "businesses", businessTotal);
  const bookingsState = sectionState(params, "bookings", bookingTotal);
  const accountsState = sectionState(params, "accounts", accountTotal);
  const reviewsState = sectionState(params, "reviews", reviewTotal);
  const categoriesState = sectionState(params, "categories", categoryTotal);
  const auditState = sectionState(params, "audit", auditTotal);
  const [categories, businesses, bookings, accounts, reviews, auditEntries] = await Promise.all([
    db.category.findMany({
      where: categoryWhere,
      orderBy: { name: "asc" },
      skip: (categoriesState.page - 1) * pageSize,
      take: pageSize,
    }),
    db.business.findMany({
      where: businessWhere,
      include: { owner: { select: { name: true, email: true } }, category: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      skip: (businessesState.page - 1) * pageSize,
      take: pageSize,
    }),
    db.booking.findMany({
      where: bookingWhere,
      include: {
        customer: { select: { name: true } },
        business: { select: { name: true } },
        service: { select: { name: true } },
      },
      orderBy: [{ date: "desc" }, { startMinute: "desc" }],
      skip: (bookingsState.page - 1) * pageSize,
      take: pageSize,
    }),
    db.user.findMany({
      where: accountWhere,
      select: { id: true, name: true, email: true, role: true, active: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      skip: (accountsState.page - 1) * pageSize,
      take: pageSize,
    }),
    db.review.findMany({
      where: reviewWhere,
      include: {
        business: { select: { name: true } },
        author: { select: { name: true } },
        booking: { select: { id: true, status: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (reviewsState.page - 1) * pageSize,
      take: pageSize,
    }),
    db.auditLog.findMany({
      where: auditWhere,
      include: { actor: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      skip: (auditState.page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return (
    <main className="pageBox">
      <div className="summaryCard">
        <h1>Administration</h1>
        <p>Review submitted businesses, account access, bookings, categories, and customer reviews.</p>
        {params.error ? <p role="alert" style={{ color: "#b91c1c", marginTop: "12px" }}>{params.error}</p> : null}
        {params.message ? <p role="status" style={{ color: "#065f46", marginTop: "12px" }}>{params.message}</p> : null}
        <div className="summaryGrid" style={{ marginTop: "18px" }}>
          <div className="summaryItem"><strong>{businessCount}</strong>business listings</div>
          <div className="summaryItem"><strong>{pendingCount}</strong>pending review</div>
          <div className="summaryItem"><strong>{customerCount}</strong>booking requests</div>
        </div>
      </div>

      <section className="tableCard" id="businesses">
        <h2>Business moderation</h2>
        {listControls(params, "businesses", businessesState.search, businessesState.page, businessesState.pageCount, businessTotal)}
        {businesses.length ? <div className="tableWrap"><table>
          <thead><tr><th>Business</th><th>Owner</th><th>Category</th><th>Status</th><th>Update</th></tr></thead>
          <tbody>{businesses.map((business) => (
            <tr key={business.id}>
              <td>{business.name}<br /><small>{business.city}</small></td>
              <td>{business.owner.name}<br /><small>{business.owner.email}</small></td>
              <td>{business.category.name}</td>
              <td>{business.status}</td>
              <td><form action={setBusinessStatus} className="inlineStatusForm">
                <input type="hidden" name="businessId" value={business.id} />
                <select name="status" defaultValue={business.status}>
                  <option value="PENDING">Pending</option><option value="APPROVED">Approve</option>
                  <option value="REJECTED">Reject</option><option value="SUSPENDED">Suspend</option>
                </select>
                <button className="reviewButton" type="submit">Save</button>
              </form></td>
            </tr>
          ))}</tbody>
        </table></div> : <p>No business listings have been submitted.</p>}
      </section>

      <section className="tableCard">
        <h2>Category management</h2>
        <form action={createCategory} className="inlineForm">
          <label>New category<input name="name" minLength={2} maxLength={80} required /></label>
          <button type="submit" className="manageButton">Add category</button>
        </form>
        {listControls(params, "categories", categoriesState.search, categoriesState.page, categoriesState.pageCount, categoryTotal)}
        <div className="categoryAdminGrid">{categories.map((category) => (
          <div className="categoryAdminItem" key={category.id}>
            <span>{category.name} · {category.active ? "Active" : "Inactive"}</span>
            <form action={setCategoryActive}>
              <input type="hidden" name="categoryId" value={category.id} />
              <input type="hidden" name="active" value={String(!category.active)} />
              <button type="submit" className="reviewButton">{category.active ? "Deactivate" : "Activate"}</button>
            </form>
          </div>
        ))}</div>
      </section>

      <section className="tableCard" id="bookings">
        <h2>Booking management</h2>
        {listControls(params, "bookings", bookingsState.search, bookingsState.page, bookingsState.pageCount, bookingTotal)}
        {bookings.length ? <div className="tableWrap"><table>
          <thead><tr><th>Customer</th><th>Business and service</th><th>Date and time</th><th>Status</th><th>Update</th></tr></thead>
          <tbody>{bookings.map((booking) => (
            <tr key={booking.id}>
              <td>{booking.customer.name}</td>
              <td>{booking.business.name}<br /><small>{booking.service.name}</small></td>
              <td>{booking.date.toISOString().slice(0, 10)} · {formatMinute(booking.startMinute)} · {booking.timezone}</td>
              <td>{booking.status}</td>
              <td><form action={setAdminBookingStatus} className="inlineStatusForm">
                <input type="hidden" name="bookingId" value={booking.id} />
                <select name="status" defaultValue="">
                  <option value="" disabled>Choose action</option>
                  {booking.status === "PENDING" ? <option value="CONFIRMED">Confirm</option> : null}
                  {booking.status === "CONFIRMED" ? <option value="COMPLETED">Complete</option> : null}
                  {booking.status === "PENDING" || booking.status === "CONFIRMED" ? <option value="CANCELLED">Cancel</option> : null}
                </select>
                <button className="reviewButton" type="submit">Update</button>
              </form></td>
            </tr>
          ))}</tbody>
        </table></div> : <p>No bookings yet.</p>}
      </section>

      <section className="tableCard" id="accounts">
        <h2>Account access</h2>
        {listControls(params, "accounts", accountsState.search, accountsState.page, accountsState.pageCount, accountTotal)}
        {accounts.length ? <div className="tableWrap"><table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Access</th><th>Action</th></tr></thead>
          <tbody>{accounts.map((account) => (
            <tr key={account.id}>
              <td>{account.name}</td><td>{account.email}</td><td>{account.role}</td><td>{account.active ? "Active" : "Suspended"}</td>
              <td><form action={setUserActive}>
                <input type="hidden" name="userId" value={account.id} />
                <input type="hidden" name="active" value={String(!account.active)} />
                <button className="reviewButton" type="submit">{account.active ? "Suspend" : "Reactivate"}</button>
              </form></td>
            </tr>
          ))}</tbody>
        </table></div> : <p>No customer or provider accounts yet.</p>}
      </section>

      <section className="tableCard" id="reviews">
        <h2>Review moderation</h2>
        {listControls(params, "reviews", reviewsState.search, reviewsState.page, reviewsState.pageCount, reviewTotal)}
        {reviews.length ? <div className="tableWrap"><table>
          <thead><tr><th>Business</th><th>Customer</th><th>Rating and review</th><th>Status</th><th>Moderate</th></tr></thead>
          <tbody>{reviews.map((review) => (
            <tr key={review.id}>
              <td>{review.business.name}</td><td>{review.author.name}</td>
              <td>{review.rating}/5<br />{review.body}<br /><small>Booking: {review.booking.status.toLowerCase()}</small></td>
              <td>{review.status}</td>
              <td><form action={setReviewStatus} className="inlineStatusForm">
                <input type="hidden" name="reviewId" value={review.id} />
                <select name="status" defaultValue={review.status}>
                  <option value="PENDING">Pending</option><option value="PUBLISHED">Publish</option><option value="HIDDEN">Hide</option>
                </select>
                <button className="reviewButton" type="submit">Save</button>
              </form></td>
            </tr>
          ))}</tbody>
        </table></div> : <p>No reviews have been submitted.</p>}
      </section>

      <section className="tableCard" id="audit">
        <h2>Audit trail</h2>
        {listControls(params, "audit", auditState.search, auditState.page, auditState.pageCount, auditTotal)}
        {auditEntries.length ? <div className="tableWrap"><table>
          <thead><tr><th>Time</th><th>Administrator or actor</th><th>Action</th><th>Record</th></tr></thead>
          <tbody>{auditEntries.map((entry) => (
            <tr key={entry.id}>
              <td>{entry.createdAt.toLocaleString()}</td><td>{entry.actor.name}</td>
              <td>{entry.action}</td><td>{entry.targetType} · {entry.targetId}</td>
            </tr>
          ))}</tbody>
        </table></div> : <p>No sensitive changes have been recorded.</p>}
      </section>
    </main>
  );
}
