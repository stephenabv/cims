# CIMS — System Architecture

Stack decision (confirmed by project owner, 2026-11-05): **TypeScript monorepo — NestJS API + Prisma + PostgreSQL, React (Vite) PWA.**

## 1. Overview

```
            ┌───────────────────────── Browser ─────────────────────────┐
            │  React PWA (apps/web)                                     │
            │   ├─ Kiosk (/)           PIN time-in/out, offline queue   │
            │   │    └─ Service worker + IndexedDB outbox               │
            │   └─ App (/app/*)        role dashboards & modules        │
            └───────────────┬───────────────────────────────────────────┘
                            │ HTTPS, JSON, httpOnly session cookie + CSRF header
                            ▼
            ┌─────────────────────── NestJS API (apps/api) ─────────────┐
            │ Controllers → Guards (Session, CSRF, Permission, Kiosk)   │
            │ Application services (use cases, transactions)            │
            │ Domain (pure: attendance calc, payroll calc, leave rules) │
            │ Infrastructure (Prisma repos, mailer, storage, crypto)    │
            └───────────────┬───────────────────────────────────────────┘
                            ▼
                     PostgreSQL 16  (single, centralised DB)
```

Single-tenant: one company per deployment (PROJECT_ANALYSIS [A-2]).

## 2. Repository layout

```
cims/
├─ apps/
│  ├─ api/                 NestJS
│  │  ├─ prisma/           schema.prisma, migrations/, seed.ts
│  │  └─ src/
│  │     ├─ common/        config, errors, filters, guards, decorators, pipes, logging
│  │     ├─ infrastructure/prisma, mail, storage, crypto, clock
│  │     └─ modules/
│  │        ├─ auth/       login, sessions, password, 2FA, recovery
│  │        ├─ access/     roles, permissions
│  │        ├─ employees/  employees, departments, positions, provisioning, history
│  │        ├─ attendance/ punches, kiosk devices, sync, conflicts, daily records
│  │        ├─ schedules/  work schedules, holidays
│  │        ├─ leave/      types, requests, approval chains, balances
│  │        ├─ overtime/   OT records & approvals, UT monitoring
│  │        ├─ payroll/    compensation, deductions, runs, payslips
│  │        ├─ projects/   projects, members, tasks, updates
│  │        ├─ dashboards/
│  │        ├─ reports/    PDF / XLSX exports
│  │        ├─ notifications/
│  │        ├─ audit/
│  │        └─ settings/
│  └─ web/                 React + Vite PWA
│     └─ src/ app/, features/<module>/, components/ui/, lib/ (api client, offline outbox)
├─ packages/
│  └─ shared/              zod schemas, enums, permission codes, DTO types (used by api & web)
├─ docs/                   this file and the other planning docs
└─ docker-compose.yml      postgres + mailpit for local dev
```

## 3. Backend architecture (NestJS)

Layered per module:

| Layer                   | Responsibility                                                                                                                                            | Depends on                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Controller**          | HTTP mapping, DTO validation (zod pipe), permission metadata                                                                                              | Application service                   |
| **Application service** | Use case orchestration, authorisation of _data scope_ (e.g. "own department"), transactions, audit events, notifications                                  | Domain, repositories (via interfaces) |
| **Domain**              | Pure, framework-free logic: attendance metrics, payroll calculator, undertime policies (strategy pattern), leave state machine, approval chain resolution | nothing                               |
| **Infrastructure**      | Prisma repositories, mailer, storage, crypto                                                                                                              | Prisma, external libs                 |

Key patterns (used because they solve a concrete problem):

- **Strategy** — undertime policy (`HourlyEquivalent`, `FixedPerBlock`, `Tiered`), overtime rate (`Multiplier`, `FixedRate`), payroll period generators (`SemiMonthly`, `Rolling15Day`, `Monthly`, `Custom`).
- **State machine** — leave request status, payroll run status, account status; invalid transitions raise `DomainError` → HTTP 409.
- **Ports & adapters** — `Mailer`, `FileStorage`, `Clock` are interfaces injected by Nest DI so tests use fakes and production swaps providers.
- **Outbox-style audit** — audit rows written in the same transaction as the change they describe.

Error handling: a global exception filter maps `DomainError` (409/422), `NotFound` (404), `Forbidden` (403), validation (400) to a uniform `{ error: { code, message, details? } }` body. Unknown errors → 500 with a correlation id; stack traces only in logs. Structured JSON logging (pino) with request id; secrets/PINs/passwords redacted.

## 4. Data architecture

PostgreSQL 16, Prisma schema + versioned migrations. Conventions: `snake_case` tables/columns, UUID v7-style ids (`uuid` PK) except human identifiers (account number), `created_at` / `updated_at` on every table, `created_by_id` / `updated_by_id` where an actor exists, soft lifecycle via status columns (no hard deletes of business records). Money in `NUMERIC(14,2)`, minutes as `INTEGER`. All timestamps `timestamptz` (UTC); business dates (`work_date`, leave dates) as `date` interpreted in the company timezone.

### Core entities (abridged ERD)

```
role ─< role_permission >─ permission
user_account 1─1 employee ─< employee_change_history
employee >─ department, >─ position, >─ employee (supervisor), >─ work_schedule, >─ role
employee ─< compensation_profile (effective_from, versioned)
employee ─< attendance_event (immutable punches)  ─> kiosk_device, sync_batch
employee ─< attendance_day (derived per work_date) ─< attendance_adjustment
attendance_conflict >─ attendance_event (1..n)
employee ─< overtime_record (per work_date)
leave_type ─< leave_request >─ employee ─< leave_approval_step
approval_chain ─< approval_chain_step
employee ─< leave_balance (per type, per year)
payroll_run ─< payroll_line (per employee) ─< payroll_line_item (earning/deduction breakdown)
deduction_type ─< employee_deduction
project ─< project_member >─ employee; project ─< task; project ─< project_update
notification >─ user_account
audit_log, auth_event, session, password_reset_token, company_setting, holiday
```

Integrity:

- Unique: `employee.account_number`, `user_account.email`, `attendance_event.client_uuid`, `attendance_day(employee_id, work_date)`, `payroll_line(run_id, employee_id)`.
- Overlapping leave prevented in a serializable transaction (application check + `SELECT … FOR UPDATE` on the employee row) — PostgreSQL exclusion constraint on `daterange` for `status IN (PENDING, APPROVED)` added via raw SQL migration as a second line of defence.
- At most one open punch per employee guaranteed by a partial unique index on `attendance_day(employee_id) WHERE open_time_in IS NOT NULL`… implemented as row lock on employee during punch.
- Optimistic concurrency: `version` column on `leave_request`, `payroll_run`, `attendance_conflict`, `employee`.
- Finalized payroll: service-level lock + DB trigger rejecting updates to lines of a `FINALIZED` run.

## 5. Authentication & authorization

### System login (credential B)

- Username = account number; password hashed with **argon2id** (memory-hard; params in config).
- **Opaque server sessions**: random 256-bit token in an `httpOnly; Secure; SameSite=Lax` cookie; only its SHA-256 hash is stored in `session`. Idle timeout (30 min default) + absolute timeout (12 h). Sessions are revoked on password change, suspension, deactivation, or role change. Chosen over JWT for instant revocation.
- **CSRF**: double-submit token (readable `cims_csrf` cookie echoed in `X-CSRF-Token` header) required on all state-changing requests; plus `SameSite`.
- **2FA (TOTP)** required for roles flagged `requires_mfa` (seed: CEO, Executive, HR, IT). Login becomes two-step (`password → mfa challenge`). Recovery codes hashed.
- **Lockout**: N failed attempts (default 5) in window → account locked for M minutes (default 15), plus IP-level throttling. All attempts written to `auth_event`.
- **Temporary passwords**: issued by IT/HR, emailed to the registered company email, TTL configurable (default 24 h), `must_change_password` enforced by a guard that allows only the change-password endpoint.
- **Self-service recovery**: request by account number → single-use, hashed, 30-min token emailed to the company address; uniform response to avoid account enumeration.

### Attendance PIN (credential A)

- 6-digit PIN hashed with argon2id; weak PINs (all same digit, sequential) rejected.
- PIN failures counted separately; lockout after 5 failures (PIN-only lockout, does not lock system login).
- Kiosk endpoints accept no session; they require a **registered kiosk device token** (issued by IT, stored hashed) unless the setting `attendance.allowUnregisteredBrowsers` is on (then IP allow-list applies).

### Authorization

- **RBAC with permission codes** (`module.action[.scope]`, e.g. `attendance.view.all`, `attendance.view.department`, `payroll.finalize`). Roles and role→permission mappings live in the DB, editable by holders of `access.manage`. Codes are defined once in `packages/shared` so UI and API agree.
- `@RequirePermissions()` decorator + `PermissionGuard` on every controller route (deny by default: a route without metadata fails closed via a global guard).
- **Data-scope checks** in application services: e.g. an Executive with `attendance.view.department` only sees employees in departments they manage; an approver may act only on steps assigned to them. These prevent IDOR regardless of UI.
- Field-level write control for employee records: self-editable fields whitelisted; restricted fields need `employees.edit.employment` / `payroll.compensation.edit`. Mass assignment prevented by explicit DTOs.

## 6. Offline attendance & synchronisation

```
Kiosk PWA                                  API
────────                                   ───
punch(acct, pin) ─online─► POST /kiosk/punch ── verify PIN, lock employee, apply rules ─► result
     │ network error / offline
     ▼
encrypt({acct,pin}) with server RSA-OAEP public key
store {clientUuid, deviceTs, ciphertext, type?} in IndexedDB outbox
     │ online event / periodic retry (exponential backoff)
     ▼
POST /kiosk/sync (batch, device token) ─► per item:
      1. dedupe by clientUuid (idempotent: already processed → return prior result)
      2. decrypt, verify PIN (wrong PIN → REJECTED, logged)
      3. validate timestamp: not in future (> skew 2 min), not older than max offline age (72 h)
      4. infer type from state at deviceTs (in/out) and check conflicts
      5. clean → applied as attendance_event(source=OFFLINE)
         conflict → stored as attendance_event(status=CONFLICT) + attendance_conflict for HR
◄─ per-item status {APPLIED | DUPLICATE | CONFLICT | REJECTED}; kiosk clears outbox entries
```

- PINs never leave the device in plaintext and the device holds no PIN hashes; it only has the server's **public** key, so a stolen kiosk cannot verify or harvest PINs.
- Raw events are immutable; HR resolution produces an `attendance_adjustment` and recomputes `attendance_day`. Originals remain for audit.
- Each sync batch is recorded (`sync_batch`) with counts and is visible on a sync-status screen.
- Offline confirmation to the employee says "Recorded offline — pending sync"; the name is not shown offline (no local directory).

## 7. Attendance & payroll computation

- `AttendanceCalculator` (domain, pure): given the day's punches, the employee's schedule, holidays and approved leave → `{workedMinutes, regularMinutes, lateMinutes, undertimeMinutes, overtimeMinutes, status: PRESENT|LATE|ABSENT|INCOMPLETE|ON_LEAVE|REST_DAY|HOLIDAY}`. Break is deducted per schedule.
- Overtime minutes create/update an `overtime_record` (PENDING) that requires approval; payroll reads only `APPROVED` minutes.
- `PayrollCalculator` (domain, pure, Decimal arithmetic): per employee per period → line items (regular pay, approved OT, paid leave, undertime deduction with policy breakdown, configured deductions, adjustments) → gross / deductions / net. Deterministic: same inputs → same output, snapshotted into `payroll_line_item` with the inputs used.
- Unit-tested with table-driven cases, including rounding (round half-up to centavo at line level).

## 8. Frontend architecture

- React 18, TypeScript strict, Vite, React Router, **TanStack Query** (server state), **react-hook-form + zod** (shared schemas), Tailwind CSS + headless accessible primitives (Radix) for the component library.
- `vite-plugin-pwa` (Workbox) caches the app shell; the kiosk route works fully offline; app routes show an offline banner.
- Feature folders mirror backend modules. Route guards read the current user's permission set from `/auth/me` purely for UX — the API remains the enforcement point.
- Every screen implements loading, empty, error and success states; tables paginate server-side.
- Responsive: mobile-first layouts, sidebar collapses to a drawer below `md`.

## 9. API conventions

- REST, JSON, base path `/api/v1`. OpenAPI generated by `@nestjs/swagger` (disabled in production unless configured).
- Pagination `?page=&pageSize=` (max 100) → `{ data, meta: { page, pageSize, total } }`.
- Filtering via explicit query params validated by zod; sorting by allow-listed fields only.
- Idempotency: kiosk sync uses `clientUuid`; state-changing approvals use `version` for optimistic locking (409 on mismatch).

## 10. Security controls (mapping to spec §5)

| Control                 | Implementation                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RBAC                    | DB roles/permissions, global deny-by-default guard, data-scope checks                                                                                                     |
| Password / PIN hashing  | argon2id                                                                                                                                                                  |
| Session management      | Opaque hashed sessions, idle + absolute timeout, revocation                                                                                                               |
| Lockout / rate limiting | Per-account counters + `@nestjs/throttler` per IP                                                                                                                         |
| 2FA                     | TOTP for `requires_mfa` roles                                                                                                                                             |
| Email restriction       | Allowed-domain list in settings, enforced in provisioning & email change                                                                                                  |
| Audit logs              | `audit_log` (append-only; DB role has no UPDATE/DELETE grant in prod), `auth_event`                                                                                       |
| HTTPS                   | TLS terminated at reverse proxy; HSTS; `Secure` cookies                                                                                                                   |
| Headers                 | helmet (CSP, frame-ancestors none, no-sniff), strict CORS to web origin                                                                                                   |
| Injection               | Prisma parameterised queries; raw SQL only via tagged templates                                                                                                           |
| XSS                     | React escaping, CSP, no `dangerouslySetInnerHTML`                                                                                                                         |
| File uploads            | Type allow-list (PDF/JPG/PNG), size limit 5 MB, magic-byte sniffing, random storage names, served via authorised download endpoint with `Content-Disposition: attachment` |
| Secrets                 | env vars validated at boot (zod), never sent to client; `.env` git-ignored                                                                                                |
| Privacy                 | Field-level access, minimal exposure in list endpoints, audit of personal-data access for payroll                                                                         |
| Backups                 | `pg_dump` scheduled job + documented restore procedure (deployment)                                                                                                       |
| Dependencies            | `pnpm audit` in CI                                                                                                                                                        |

## 11. Deployment architecture

Reference: Docker Compose — `reverse-proxy (Caddy, auto-TLS) → web (static) + api (Node 22) → postgres 16`, plus a scheduled backup container. Configuration by environment variables. Migrations run as a release step (`prisma migrate deploy`). Background jobs (session cleanup, daily absence marking, temp-password expiry) run in-process via `@nestjs/schedule` with a DB advisory lock so only one instance executes each job. Hosting target pending (PROJECT_ANALYSIS Q-6).

## 12. Timezone

Company timezone stored in settings (default `Asia/Manila`). All business-date derivation (`work_date`, period boundaries, report ranges) uses Luxon with that zone. The API returns ISO-8601 UTC timestamps; the UI renders them in the company timezone.
