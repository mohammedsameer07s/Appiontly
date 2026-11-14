export const dynamic = "force-dynamic";

import Link from "next/link";

import styles from "./page.module.css";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { activePublicBusinessFilter } from "@/lib/workflows";
import { getAvailableStartMinutes, formatMinuteOfDay } from "@/lib/availability";
import { distanceInKilometers } from "@/lib/location";
import { getWeekday, isValidBookingDate, isValidCalendarDate } from "@/lib/validation";

type MarketplaceParams = {
  q?: string;
  category?: string;
  city?: string;
  page?: string;
  minPrice?: string;
  maxPrice?: string;
  sort?: string;
  availableDate?: string;
  latitude?: string;
  longitude?: string;
  radius?: string;
};

function queryForPage(params: MarketplaceParams, page: number) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && key !== "page") query.set(key, value);
  }
  query.set("page", String(page));
  return query.toString();
}

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<MarketplaceParams>;
}) {
  const params = (await searchParams) ?? {};
  const searchTerm = params.q?.trim().slice(0, 100) ?? "";
  const city = params.city?.trim().slice(0, 80) ?? "";
  const minPrice = params.minPrice?.trim() ? Number(params.minPrice) : Number.NaN;
  const maxPrice = params.maxPrice?.trim() ? Number(params.maxPrice) : Number.NaN;
  const minPriceCents = Number.isFinite(minPrice) && minPrice >= 0 && minPrice <= 99_999 ? Math.round(minPrice * 100) : null;
  const maxPriceCents = Number.isFinite(maxPrice) && maxPrice >= 0 && maxPrice <= 99_999 ? Math.round(maxPrice * 100) : null;
  const requestedLatitude = Number(params.latitude);
  const requestedLongitude = Number(params.longitude);
  const hasCoordinates = params.latitude?.trim() !== undefined && params.longitude?.trim() !== undefined &&
    params.latitude.trim() !== "" && params.longitude.trim() !== "" &&
    Number.isFinite(requestedLatitude) && requestedLatitude >= -90 && requestedLatitude <= 90 &&
    Number.isFinite(requestedLongitude) && requestedLongitude >= -180 && requestedLongitude <= 180;
  const radius = Number(params.radius);
  const radiusKm = Number.isFinite(radius) && radius >= 1 && radius <= 100 ? radius : 10;
  const availableDate = params.availableDate && isValidCalendarDate(params.availableDate) ? params.availableDate : "";
  const sort = ["newest", "lowest-price", "highest-price", "soonest", "nearest"].includes(params.sort ?? "")
    ? params.sort!
    : "newest";
  const hasLocationInput = Boolean(params.latitude?.trim() || params.longitude?.trim());
  const showAdvancedFilters = Boolean(
    params.minPrice?.trim() ||
      params.maxPrice?.trim() ||
      params.availableDate?.trim() ||
      sort !== "newest" ||
      hasLocationInput ||
      (params.radius?.trim() && params.radius.trim() !== "10"),
  );
  const needsFiltering = Boolean(
    availableDate ||
      hasCoordinates ||
      sort === "lowest-price" ||
      sort === "highest-price" ||
      (sort === "soonest" && availableDate) ||
      (sort === "nearest" && hasCoordinates),
  );
  const requestedPage = Number(params.page);
  const currentPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 1000) : 1;
  const pageSize = 30;
  const user = await getSessionUser();
  const servicePriceWhere = {
    ...(minPriceCents !== null ? { gte: minPriceCents } : {}),
    ...(maxPriceCents !== null ? { lte: maxPriceCents } : {}),
  };
  const where = {
    ...activePublicBusinessFilter(),
    category: params.category ? { active: true, slug: params.category } : { active: true },
    ...(city ? { city: { contains: city, mode: "insensitive" as const } } : {}),
    ...(minPriceCents !== null || maxPriceCents !== null
      ? {
          services: {
            some: {
              active: true,
              priceCents: servicePriceWhere,
            },
          },
        }
      : {}),
    ...(hasCoordinates
      ? {
          latitude: { gte: requestedLatitude - radiusKm / 111, lte: requestedLatitude + radiusKm / 111 },
          longitude: {
            gte: Math.max(-180, requestedLongitude - radiusKm / Math.max(1, 111 * Math.cos(requestedLatitude * Math.PI / 180))),
            lte: Math.min(180, requestedLongitude + radiusKm / Math.max(1, 111 * Math.cos(requestedLatitude * Math.PI / 180))),
          },
        }
      : {}),
    AND: [
      ...(maxPriceCents !== null && minPriceCents !== null && maxPriceCents < minPriceCents
        ? [{ id: "__no_matches__" }]
        : []),
      ...(availableDate
        ? [{
            OR: [
              { scheduleExceptions: { some: { date: new Date(`${availableDate}T00:00:00.000Z`), isClosed: false, shifts: { some: {} } } } },
              {
                AND: [
                  { scheduleExceptions: { none: { date: new Date(`${availableDate}T00:00:00.000Z`) } } },
                  { availability: { some: { weekday: getWeekday(availableDate) } } },
                ],
              },
            ],
          }]
        : []),
      ...(searchTerm
        ? [{
            OR: [
            { name: { contains: searchTerm, mode: "insensitive" as const } },
            { description: { contains: searchTerm, mode: "insensitive" as const } },
            { category: { name: { contains: searchTerm, mode: "insensitive" as const } } },
            { services: { some: { active: true, name: { contains: searchTerm, mode: "insensitive" as const } } } },
            ],
          }]
        : []),
    ],
  };
  const [categories, matchedCount, matches] = await Promise.all([
    db.category.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    db.business.count({ where }),
    db.business.findMany({
      where,
      include: {
        category: { select: { name: true } },
        services: {
          where: { active: true, ...(Object.keys(servicePriceWhere).length ? { priceCents: servicePriceWhere } : {}) },
          select: { id: true, name: true, priceCents: true, durationMinutes: true },
          orderBy: { priceCents: "asc" },
        },
        availability: true,
        scheduleExceptions: {
          where: availableDate ? { date: new Date(`${availableDate}T00:00:00.000Z`) } : undefined,
          include: { shifts: true },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: needsFiltering ? 0 : (currentPage - 1) * pageSize,
      take: needsFiltering ? 5000 : pageSize,
    }),
  ]);
  let businesses = matches.map((business) => ({
    ...business,
    distanceKm: hasCoordinates && business.latitude !== null && business.longitude !== null
      ? distanceInKilometers(requestedLatitude, requestedLongitude, business.latitude, business.longitude)
      : null,
    availableAt: null as string | null,
  }));
  if (hasCoordinates) businesses = businesses.filter((business) => business.distanceKm !== null && business.distanceKm <= radiusKm);
  if (availableDate) {
    const activeBusinessIds = businesses.map((business) => business.id);
    const occupied = activeBusinessIds.length
      ? await db.booking.findMany({
          where: {
            businessId: { in: activeBusinessIds },
            date: new Date(`${availableDate}T00:00:00.000Z`),
            status: { in: ["PENDING", "CONFIRMED"] },
          },
          select: { businessId: true, startMinute: true, durationMinutes: true, status: true },
        })
      : [];
    const occupiedByBusiness = new Map<string, typeof occupied>();
    for (const booking of occupied) {
      const group = occupiedByBusiness.get(booking.businessId) ?? [];
      group.push(booking);
      occupiedByBusiness.set(booking.businessId, group);
    }
    businesses = businesses.flatMap((business) => {
      if (!isValidBookingDate(availableDate, new Date(), business.timezone)) return [];
      const exception = business.scheduleExceptions[0];
      const windows = exception
        ? exception.isClosed ? [] : exception.shifts
        : business.availability.filter((window) => window.weekday === getWeekday(availableDate));
      const earliest = business.services.flatMap((service) =>
        getAvailableStartMinutes(
          availableDate,
          business.timezone,
          service.durationMinutes,
          windows,
          occupiedByBusiness.get(business.id) ?? [],
        ).map((minute) => ({ minute, service })),
      ).sort((a, b) => a.minute - b.minute)[0];
      return earliest
        ? [{ ...business, availableAt: `${formatMinuteOfDay(earliest.minute)} · ${earliest.service.name}` }]
        : [];
    });
  } else if (availableDate) {
    businesses = [];
  }
  if (sort === "lowest-price") {
    businesses.sort((a, b) => (a.services[0]?.priceCents ?? Infinity) - (b.services[0]?.priceCents ?? Infinity));
  } else if (sort === "highest-price") {
    businesses.sort((a, b) => (b.services[0]?.priceCents ?? 0) - (a.services[0]?.priceCents ?? 0));
  } else if (sort === "nearest") {
    businesses.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  } else if (sort === "soonest") {
    businesses.sort((a, b) => (a.availableAt ?? "\uffff").localeCompare(b.availableAt ?? "\uffff"));
  }
  const businessCount = needsFiltering ? businesses.length : matchedCount;
  const resultLimitReached = needsFiltering && matches.length === 5000;
  const pageBusinesses = needsFiltering
    ? businesses.slice((currentPage - 1) * pageSize, currentPage * pageSize)
    : businesses;
  const ratings = pageBusinesses.length
    ? await db.review.groupBy({
        by: ["businessId"],
        where: { businessId: { in: pageBusinesses.map((business) => business.id) }, status: "PUBLISHED" },
        _avg: { rating: true },
        _count: { _all: true },
      })
    : [];
  const ratingByBusiness = new Map(ratings.map((rating) => [rating.businessId, rating]));
  const categoryFilter = params.category ?? "";

  return (
    <main className={styles.page}>
      <section className={styles.heroSection}>
        <div className={styles.heroText}>
          <span className={styles.kicker}>Appointments made clearer</span>
          <h1>Find a service. Choose a time. Book directly.</h1>
          <p>
            Explore admin-approved local businesses, see their services and prices, and request an
            appointment time that fits their published availability.
          </p>
          <div className={styles.ctaRow}>
            <Link href="#businesses" className={styles.primaryButton}>Browse businesses</Link>
            <Link href="/provider/register" className={styles.secondaryButton}>List your business</Link>
          </div>
          <div className={styles.statsGrid}>
            <div><strong>{businessCount}</strong><span>matching businesses</span></div>
            <div><strong>{categories.length}</strong><span>active categories</span></div>
            <div><strong>Online</strong><span>booking requests</span></div>
          </div>
        </div>

        <div className={styles.heroCard}>
          <div className={styles.quickSearchHeader}>
            <span>Search local services</span>
          </div>
          <form className={styles.searchForm} method="get">
            {maxPriceCents !== null && minPriceCents !== null && maxPriceCents < minPriceCents
              ? <p role="alert">Maximum price must be greater than or equal to minimum price.</p>
              : null}
            {sort === "nearest" && !hasCoordinates
              ? <p>Enter your latitude and longitude to sort by distance.</p>
              : null}
            {sort === "soonest" && !availableDate
              ? <p>Choose an availability date to sort by soonest open appointment.</p>
              : null}
            <div className={styles.primarySearchGrid}>
              <label>
                <span>Business or service</span>
                <input name="q" defaultValue={searchTerm} maxLength={100} placeholder="Search services" />
              </label>
              <label>
                <span>City</span>
                <input name="city" defaultValue={city} maxLength={80} placeholder="Any city" />
              </label>
              <label>
                <span>Category</span>
                <select name="category" defaultValue={categoryFilter}>
                  <option value="">All categories</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.slug}>{category.name}</option>
                  ))}
                </select>
              </label>
            </div>
            <details className={styles.advancedFilters} open={showAdvancedFilters}>
              <summary>More filters</summary>
              <div className={styles.advancedFilterGrid}>
                <label>
                  <span>Minimum price (₹)</span>
                  <input name="minPrice" type="number" min="0" max="99999" step="0.01" defaultValue={params.minPrice ?? ""} />
                </label>
                <label>
                  <span>Maximum price (₹)</span>
                  <input name="maxPrice" type="number" min="0" max="99999" step="0.01" defaultValue={params.maxPrice ?? ""} />
                </label>
                <label>
                  <span>Available on</span>
                  <input name="availableDate" type="date" defaultValue={availableDate} />
                </label>
                <label>
                  <span>Sort results</span>
                  <select name="sort" defaultValue={sort}>
                    <option value="newest">Newest</option>
                    <option value="lowest-price">Lowest price</option>
                    <option value="highest-price">Highest price</option>
                    <option value="soonest">Soonest available</option>
                    <option value="nearest">Nearest (add location)</option>
                  </select>
                </label>
                <label>
                  <span>Your latitude</span>
                  <input name="latitude" type="number" min="-90" max="90" step="any" defaultValue={params.latitude ?? ""} />
                </label>
                <label>
                  <span>Your longitude</span>
                  <input name="longitude" type="number" min="-180" max="180" step="any" defaultValue={params.longitude ?? ""} />
                </label>
                <label>
                  <span>Within (km)</span>
                  <input name="radius" type="number" min="1" max="100" step="1" defaultValue={params.radius ?? "10"} />
                </label>
              </div>
            </details>
            <button type="submit" className={styles.primaryButton}>Search</button>
          </form>
          <p className={styles.trustNote}>Transparent services and prices · Moderated customer reviews</p>
        </div>
      </section>

      <section className={styles.serviceBanner}>
        <div className={styles.bannerItem}>Choose a business</div>
        <div className={styles.bannerItem}>Select a listed service</div>
        <div className={styles.bannerItem}>Request an open slot</div>
        <div className={styles.bannerItem}>Track your booking</div>
      </section>

      <section className={styles.section} id="businesses">
        <div className={styles.sectionHeader}>
          <span>Browse</span>
          <h2>Active service categories</h2>
        </div>
        <div className={styles.categoryGrid}>
          {categories.map((category) => (
            <Link key={category.id} href={`/?category=${encodeURIComponent(category.slug)}#businesses`} className={styles.categoryCard}>
              <div className={styles.categoryIcon}>{category.name.slice(0, 1)}</div>
              <h3>{category.name}</h3>
              <p>Browse businesses</p>
            </Link>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span>Marketplace</span>
          <h2>{businessCount} {businessCount === 1 ? "business" : "businesses"} found</h2>
        </div>
        <div className={styles.businessGrid}>
          {pageBusinesses.length ? pageBusinesses.map((business) => {
            const rating = ratingByBusiness.get(business.id);
            const reviewCount = rating?._count._all ?? 0;
            const average = rating?._avg.rating?.toFixed(1) ?? null;
            return (
              <article key={business.id} className={styles.businessCard}>
                <div className={styles.businessImage}>{business.name.slice(0, 2).toUpperCase()}</div>
                <div className={styles.businessBody}>
                  <div className={styles.cardHeader}>
                    <div><h3>{business.name}</h3><p>{business.category.name}</p></div>
                    <span className={styles.rating}>{average ? `${average} / 5` : "New"}</span>
                  </div>
                  <p className={styles.businessDescription}>{business.description}</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", margin: "12px 0" }}>
                    {business.services.slice(0, 3).map((service) => (
                      <span key={service.id} style={{ background: "#e0f2fe", color: "#075985", borderRadius: "999px", padding: "4px 8px", fontSize: "0.72rem", fontWeight: 700 }}>
                        {service.name} · ₹{(service.priceCents / 100).toFixed(2)}
                      </span>
                    ))}
                  </div>
                  <div className={styles.metaLine}>{business.city}</div>
                  {business.distanceKm !== null ? <div className={styles.metaLine}>{business.distanceKm.toFixed(1)} km away</div> : null}
                  {business.availableAt ? <div className={styles.metaLine}>Available {business.availableAt}</div> : null}
                  <div className={styles.metaLine}>{reviewCount} verified {reviewCount === 1 ? "review" : "reviews"}</div>
                  <div className={styles.cardFooter}>
                    <strong>{business.timezone}</strong>
                    <Link href={`/business/${business.id}`}>View services</Link>
                  </div>
                </div>
              </article>
            );
          }) : (
            <div className={styles.emptyState}>
              No approved businesses match this search yet. Providers can submit a listing for admin review.
            </div>
          )}
        </div>
        {businessCount > pageSize ? (
          <nav aria-label="Business result pages" className="pagination">
            {currentPage > 1 ? <Link href={`/?${queryForPage(params, currentPage - 1)}#businesses`}>Previous</Link> : <span />}
            <span>Page {currentPage} of {Math.ceil(businessCount / pageSize)}</span>
            {currentPage * pageSize < businessCount ? <Link href={`/?${queryForPage(params, currentPage + 1)}#businesses`}>Next</Link> : <span />}
          </nav>
        ) : null}
        {resultLimitReached ? <p role="status">Results are capped at 5,000 for this filtered search. Narrow the filters to see more precise matches.</p> : null}
      </section>

      {!user ? (
        <div className={styles.authBanner}>
          <p>Create an account to request and manage appointments.</p>
          <div>
            <Link href="/register" className={styles.primaryButton}>Create account</Link>
            <Link href="/login" className={styles.secondaryButton}>Login</Link>
          </div>
        </div>
      ) : null}
    </main>
  );
}
