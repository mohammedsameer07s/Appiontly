# Appointly

Appointly is a Next.js appointment marketplace with PostgreSQL persistence, Prisma migrations, database-backed sessions, and separate customer, provider, and administrator workflows. It is an application codebase—not a deployed service or a legal/compliance certification.

## Requirements

- Node.js 20.9 or newer (Node 22 LTS recommended)
- Docker Compose, or a PostgreSQL 14+ server you administer
- npm

## Local setup

```powershell
npm ci
Copy-Item .env.example .env
docker compose up -d
npm run db:migrate
npm run db:seed
npm run dev
```

Open <http://localhost:3000>. The Compose file provisions a **local development database only** with a local-only password. Do not reuse those credentials outside a developer workstation. For a separately managed PostgreSQL server, set `DATABASE_URL` in the ignored `.env` file to its connection string before running migrations. Keep production database credentials and administrator credentials in your deployment's secret manager.

If the site displays **Database setup required**, the process did not load a `DATABASE_URL`. From the project root, copy `.env.example` to `.env`, ensure the PostgreSQL service is running with `docker compose up -d`, run `npm run db:migrate` and `npm run db:seed`, then stop and restart `npm run dev`. The app intentionally shows setup instructions only when the variable is missing; a configured but unreachable or misconfigured database still reports its real connection error. It never substitutes demo or in-memory data.

On Windows, stop Appointly's running Next.js processes before `npm ci` or `npm run db:generate`: Prisma's native query-engine DLL may be locked by the live server and Windows will reject the generator's atomic rename (`EPERM`). Prisma Client is generated once by `npm ci`'s `postinstall`, not before every test, build, seed, or server start. After changing the Prisma schema, stop the app, run `npm run db:generate`, apply the migration, and restart it. Normal `npm test`, `npm run build`, and `npm start` do not attempt to replace the loaded DLL.

The initial Prisma migration enables PostgreSQL's `btree_gist` extension and adds database constraints preventing overlapping active reservations. The database role applying migrations must be permitted to create that extension. If the hosted PostgreSQL service does not allow this, have its administrator enable `btree_gist` before deployment.

## Accounts and seed data

`npm run db:seed` creates the active service categories. It creates **no sample businesses, customers, or demo credentials**. To bootstrap an administrator, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` or the secret environment before seeding. Use a unique password of at least 12 characters and no more than 72 UTF-8 bytes. `ADMIN_NAME` and `ADMIN_PHONE` are optional; the seed command hashes the password and never stores or prints its plaintext. If the configured account already exists, seeding does not reset its password or role.

Customers can create accounts from the site. New accounts receive email verification links; email must be verified before a customer can book. Phone verification is optional and available to people who opt in to SMS. Password recovery links and verification codes are single-use and expire. Administrator sign-in requires a short-lived email code after the password. Providers can submit a business with its first service; the business remains private until an administrator approves it. New provider listings receive a Monday–Friday 09:00–17:00 local-time schedule that the provider can change to multiple daily shifts, plus date-specific closures or replacement hours up to a year ahead. Schedule edits that would invalidate an active booking are rejected. Prices are stored as integer paise and shown as INR. Appointment dates/times are business-local values in the selected IANA time zone; ambiguous or nonexistent daylight-saving times are rejected. The business time zone cannot change while bookings are pending or confirmed; each booking retains its own time-zone snapshot.

## Database and production deployment

Development schema changes:

```powershell
npm run db:dev
```

Apply committed migrations in a release/deployment job:

```powershell
npm run db:migrate
npm run db:seed
npm run build
npm start
```

Set `DATABASE_URL` to the deployment PostgreSQL connection string, provision the administrator through protected environment variables, and set `NODE_ENV=production` so session cookies are Secure. Use TLS, restricted database access, managed backups and restore testing, monitoring, log retention, and a tested secret-rotation/recovery procedure before handling real customers. Use a stable `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` shared by all Next.js instances when the deployment runs multiple instances; see the installed Next.js Server Actions security guide. The database migrations and schema do not provision hosting, backups, observability, or operational policies.

Sessions use a cryptographically random opaque cookie token; only its SHA-256 digest is stored in the database. Cookies are HTTP-only, SameSite=Lax, expire after seven days, and are Secure in production. Passwords are bcrypt hashes. Authentication uses a database-backed failed-login throttle keyed by the email/client address and by the client address. If deployed behind a proxy, configure it to overwrite `X-Forwarded-For`; do not trust a client-supplied forwarding header. Server actions independently re-check the session, role, ownership, form values, and allowed booking-state transitions. Bookings are reserved only inside configured opening hours; overlap checks run in serializable transactions and a PostgreSQL exclusion constraint protects against concurrent requests. Reviews can be submitted only by the customer for their completed booking and remain unpublished until an administrator approves them. Sensitive moderation and booking/account changes are recorded in the audit log.

## Integrations, payments, and scheduled work

Email, SMS, and payment adapters are implemented but remain disabled until configured. Copy the empty settings in `.env.example` to your ignored `.env` or use your deployment secret manager. Set `APP_URL` to the canonical HTTPS origin. Set `RESEND_API_KEY` and a verified `EMAIL_FROM` address for email; set the Twilio account SID, auth token, and sender number for SMS. Users only receive SMS after opting in. Do not put credentials in source control.

Set `AUTH_TOKEN_SECRET` to at least 32 random bytes; it HMAC-protects short-lived phone and administrator email codes stored in the database.


Configure a scheduler to `POST /api/cron/notifications` with `Authorization: Bearer <CRON_SECRET>` every few minutes. The worker retries email/SMS delivery and expires unanswered pending requests after 24 hours. Without a configured scheduler, notifications remain queued and unanswered requests do not expire automatically. Monitor delivery failures and expired notifications in the database; external delivery is at-least-once if a worker terminates after provider acceptance.

Razorpay checkout is available for provider-confirmed bookings. Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`; configure Razorpay to send signed `payment_link.paid`, `payment_link.cancelled`, `refund.processed`, and `refund.failed` events to `/api/webhooks/razorpay`. Customers can request a full refund when cancelling at least 24 hours before the appointment; provider/admin cancellations are fully refundable. Payments received after a booking is cancelled are automatically refunded. Refund-provider failures are logged and surfaced as `REFUND_PENDING` for reconciliation; do not treat a payment link or browser redirect as proof of payment—the signed webhook is authoritative. Use Razorpay test credentials and verified webhook delivery before enabling live charges.

Marketplace search supports service-price filters, date-specific live availability, sorting, and distance filters. Providers enter latitude/longitude themselves; no geocoder or location tracking is used. Highly filtered searches evaluate up to 5,000 candidates at once.

There is no production deployment configured by this repository. Email delivery, SMS delivery, payment processing, the scheduled worker, backups, monitoring, and operational policies must be configured and tested separately. Do not represent an approved business listing as a credential, license, or identity verification. Add jurisdiction-specific privacy, retention, consumer-protection, accessibility, and healthcare/regulated-service review before launch where applicable.

## Quality checks

```powershell
npm run lint
npm test
npm run build
```

The automated tests cover password/date/time validation, availability boundaries, live slot generation, distance calculations, booking overlap/status rules, and role/ownership policies. Database workflow tests exercise booking, schedule changes, suspension, session revocation, public listing visibility, and review moderation against PostgreSQL. They always run under `npm test`; workflow tests never silently skip.

For the Compose test database:

```powershell
docker compose --profile test up -d --wait postgres-test
npm test
```

The Compose test service uses the separate `appointly_test` database on port 5433; its connection URL is already provided as `DATABASE_URL_TEST` in `.env.example`. The workflow runner applies pending migrations before running the DB tests. With PostgreSQL `initdb`, `pg_ctl`, and `createdb` tools installed (or `PG_BIN` pointing to their directory), leaving `DATABASE_URL_TEST` blank makes it provision and clean up a fresh isolated cluster automatically. To use that mode from PowerShell even when the example `.env` sets the Compose URL:

```powershell
$env:DATABASE_URL_TEST = ""
npm test
```

If neither a separate test URL nor local PostgreSQL binaries are available, tests fail with setup guidance and confirm workflow tests were not run. The runner refuses to use the same host, port, and database as `DATABASE_URL`. Install PostgreSQL, start the Compose `postgres-test` service, or supply an isolated test database before retrying. `npm run test:unit` runs only database-independent rule tests; `npm run test:workflow` runs the required database-backed workflows.
