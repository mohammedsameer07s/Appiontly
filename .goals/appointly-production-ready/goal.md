# Goal: Make Appointly a production-ready booking platform

## User Request

“do all things” — referring to the previously listed pending work: replace local JSON persistence with a real database; secure authentication; complete booking workflows; service/category management; admin tools; customer trust and communication; remove demo content; and improve testing and launch readiness. The user selected PostgreSQL + Prisma and local development plus deployment-ready setup, and said paid integrations will be purchased later.

## Refined Goal

Turn the current Appointly MVP into a complete, secure, deployment-ready appointment marketplace using PostgreSQL and Prisma. Implement real customer, provider, and admin workflows for listings, services, availability, bookings, moderation, and reviews; remove misleading demo metrics and ratings; and add automated verification and setup documentation. Do not claim third-party notifications, payments, backups, or a live deployment are operational without credentials and services; provide clean configuration seams and document those requirements for later.

## Acceptance Criteria

- [ ] All application data is persisted through Prisma/PostgreSQL with a documented schema/migration and seed strategy; JSON-file storage is no longer the runtime persistence path.
- [ ] Authentication stores password hashes only, validates inputs server-side, uses secure expiring sessions, and enforces customer/provider/admin authorization on all mutations.
- [ ] Providers can manage their own businesses, categories/services, service prices/durations, and bookable availability; only authorized provider actions affect their own listings and bookings.
- [ ] Customers can search approved businesses, book a valid service/available slot, view booking status, and cancel/reschedule only when allowed; conflicting or invalid bookings are rejected.
- [ ] Admins can manage users, categories, business approval/rejection/suspension, bookings, and review moderation, with meaningful errors and an audit trail for sensitive changes.
- [ ] Reviews are linked to completed customer bookings; fabricated ratings, reviews, operational metrics, and hard-coded featured business claims are removed or derived from stored data.
- [ ] Email/SMS/payment integrations are not falsely represented as active; configuration requirements and safe integration points are documented without requiring paid credentials for local startup.
- [ ] Automated tests cover core validation, role/ownership authorization, booking availability/conflicts, and key admin/provider/customer workflows.
- [ ] README documents environment setup, PostgreSQL startup/configuration, migrations, seed/demo-account behavior, tests, and deployment prerequisites; secret values are not committed.
- [ ] `npm run lint`, the automated test command, and `npm run build` pass; the local app starts and key unauthenticated/authenticated routes behave as intended.

## Scope Boundaries

**In scope:**
- PostgreSQL + Prisma schema, migrations, seed data, and deployment-ready environment configuration.
- Secure authentication/session handling, form validation, role/ownership authorization, business/service/category management, booking availability and lifecycle, admin moderation, verified reviews, automated tests, and project documentation.
- Remove misleading static/demo content and make any remaining sample data explicitly development-only.

**Out of scope:**
- Purchasing or configuring paid third-party services, live email/SMS delivery, payment processing, or production hosting; the user will purchase integrations later.
- Claiming production deployment, legal/compliance certification, backups, monitoring, or real provider verification without the required infrastructure, credentials, and operational policies.
- Adding unsupported marketplace features unrelated to the listed pending work.

## Applicable Project Conventions

**Quality gate command:**
- `npm run lint`
- `npm test` (add a focused automated test suite and script if none exists)
- `npm run build`

**Commit convention:**
- Conventional commits with iteration markers: `type(scope): [B/I] description`.
- Include the required `Assisted-by:` trailer and `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer.

**Guidelines:**
- `AGENTS.md`
- No `CONSTITUTION.md`, `.agents/guidelines/`, `.github/guidelines/`, Makefile, or justfile was found during discovery.

**Rules:**
- Follow `AGENTS.md`; before changing Next.js code, read the relevant documentation in `node_modules/next/dist/docs/`.
- The existing `next.config.ts` uses Next.js 16.4.5; verify configuration/API compatibility against the installed documentation.
- Preserve unrelated worktree changes and do not commit secrets.
