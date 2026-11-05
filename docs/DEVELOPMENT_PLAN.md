# CIMS — Development Plan

Implementation proceeds in phases; each phase ends with passing type-check, lint, unit + integration tests, and a production build. Module dependencies are shown so phases can be reordered safely.

```
Foundation ─► Access/Auth ─► Employees/Org ─► Schedules ─► Attendance ─► Offline sync
                                   │                          │
                                   ├──────► Leave ◄───────────┤
                                   │                          ▼
                                   │                  Overtime/Undertime ─► Payroll ─► Reports
                                   └──────► Projects                                     ▲
                    Notifications, Audit (cross-cutting, from Phase 3) ─────────────────┘
                    Dashboards (after the modules they summarise)
```

## Phase 1 — Repository discovery ✅

Spec read in full; repository was empty (README only). No mockups, ERDs or API specs supplied — UI follows the documented workflows and a consistent design system.

## Phase 2 — Requirements & architecture ✅

`PROJECT_ANALYSIS.md`, `SYSTEM_ARCHITECTURE.md`, this plan, `IMPLEMENTATION_TRACKER.md`. Stack confirmed by owner.

## Phase 3 — Foundation

- pnpm workspace (`apps/api`, `apps/web`, `packages/shared`), TS strict, ESLint + Prettier, shared tsconfig.
- `docker-compose.yml` (postgres 16, mailpit). `.env.example`. Config validation with zod at boot.
- NestJS skeleton: config, Prisma module, pino logging + request id, global exception filter, zod validation pipe, helmet, CORS, throttler, health endpoint.
- Prisma schema v1 for Access, Employees/Org, Settings, Audit, Sessions; first migration; seed (roles, permissions, company settings, IT admin bootstrap from env).
- React app skeleton: router, layout shell, API client with CSRF handling, TanStack Query, UI primitives, toast, error boundary.
- Test harness: Jest (api, unit + integration against a real Postgres test DB), Vitest + Testing Library (web), Playwright (e2e).
- CI workflow (GitHub Actions): install, lint, typecheck, test, build, audit.

## Phase 4 — Access, authentication & audit (M1, M11, M12-partial)

- Login (account number + password), opaque sessions, logout, `/auth/me`.
- Lockout + throttling, auth_event logging.
- Change password; forced change for temp passwords; temp password issuance (IT/HR) with TTL; self-service recovery via email.
- TOTP enrolment/verification for `requires_mfa` roles, recovery codes.
- Roles & permissions admin (list, create role, edit mappings).
- Audit log service + viewer.
- **Tests**: hashing, lockout, session expiry/revocation, CSRF rejection, permission guard deny-by-default, MFA flow, temp password expiry.

## Phase 5 — Employees & organisation (M2, M12)

- Departments, positions, supervisor hierarchy.
- Provisioning workflow (8 steps from §3.10): account number generator, role/department, company-email domain check, initial password, PIN, activation.
- Profile view/edit (self fields vs restricted fields), change history.
- Suspend / deactivate / reactivate (revokes sessions, blocks punches).
- Settings: allowed email domains, timezone, security params.
- **Tests**: domain restriction, immutable account number, field-level authorisation, history entries, deactivation effects.

## Phase 6 — Schedules & attendance (M3)

- Work schedules, holidays, employee schedule assignment.
- Kiosk device registration (IT).
- Kiosk landing page; `POST /kiosk/punch` (PIN verify, PIN lockout, duplicate/debounce, open-punch rules, row lock).
- `AttendanceCalculator` domain + `attendance_day` recomputation; nightly job marking absences/incomplete.
- My attendance history; HR attendance monitor; HR adjustments with reason & audit.
- **Tests**: calculator table tests (late, UT, OT, break, overnight, rest day, holiday, leave), concurrent punch race, deactivated punch rejection.

## Phase 7 — Offline sync (§4)

- PWA service worker; IndexedDB outbox; RSA-OAEP encryption of punch payload; retry with backoff; sync status UI.
- `POST /kiosk/sync`: idempotency, timestamp validation, conflict detection, per-item results, `sync_batch` log.
- HR conflict review/resolution screen.
- **Tests**: duplicate replay, out-of-order batches, future/stale timestamps, conflicting time-ins, multi-device, e2e offline→online.

## Phase 8 — Leave (M4)

- Leave types (seeded + custom, paid flag), approval chains (configurable steps: SUPERVISOR, ROLE, SPECIFIC_EMPLOYEE), balances (optional per type).
- Apply (working-day count, overlap check, attachments), withdraw, HR cancel, approve/reject per step with optimistic locking, notifications.
- **Tests**: state machine, chain resolution (missing supervisor fallback), overlap, concurrent approvals, attachment validation.

## Phase 9 — Overtime & undertime monitoring (M5)

- OT records from attendance; approve/reject (partial approval minutes); UT thresholds; daily/monthly summaries; history.

## Phase 10 — Payroll (M6)

- Compensation profiles (versioned), deduction types & employee deductions, undertime/OT strategies.
- Period generators; preliminary run; review/validate; adjustments; finalize (lock); payslip view; recompute on draft only.
- **Tests**: calculator table tests incl. rounding, each undertime policy, unapproved OT excluded, finalized lock, permission matrix.

## Phase 11 — Projects & tasks (M7)

- Projects, members, tasks (priority, deadline, progress, status), updates/remarks, visibility rules.

## Phase 12 — Dashboards (M8) & notifications UI (M10)

- Widget endpoints per permission; Employee / HR / Executive / CEO dashboards.

## Phase 13 — Reports & exports (M9)

- Report queries with filters; XLSX (ExcelJS) and PDF exports; payslip PDF.

## Phase 14 — Hardening & release

- Security review, dependency audit, accessibility audit (WCAG 2.1 AA), performance indexes, backup/restore runbook, production Docker images, deployment docs.

## Testing strategy summary

| Level       | Tooling                              | Scope                                                                              |
| ----------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| Unit        | Jest / Vitest                        | Domain calculators, state machines, validators, policies                           |
| Integration | Jest + Supertest + real Postgres     | Every endpoint: happy path, validation, 401/403, scope (IDOR), conflict            |
| E2E         | Playwright                           | Kiosk punch (online/offline), login+MFA, provisioning, leave approval, payroll run |
| Static      | `tsc --noEmit`, ESLint, `pnpm audit` | All packages                                                                       |
