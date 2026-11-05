# CIMS — Project Analysis

> Source of truth: _Company Information Management System (CIMS) — Project Overview and Initial System Requirements_ (DOCX supplied by the project owner, 2026-11-05). Section references below (e.g. §3.1) point to that document.
> This file consolidates the requirements, records assumptions, and lists open questions. Where the spec is silent, the assumption taken is marked **[A-n]**; open questions are marked **[Q-n]**.

## 1. Project overview

CIMS is an **internal, single-company web platform** that centralises employee records, attendance, leave, overtime/undertime, payroll computation, and project/task tracking (§1, §8). It is accessed only by authorised company personnel, has **no public registration** (§3.9), and must keep **attendance recording working offline** with later synchronisation and conflict review (§4).

## 2. Primary objectives

1. Replace manual attendance logging with PIN-based time-in/time-out on a default landing page (§3.1).
2. Automate payroll computation from attendance, hourly rates, approved overtime, undertime policies, and configurable deductions (§3.4).
3. Run leave applications through a configurable, hierarchy-based approval chain (§3.3).
4. Keep a single, auditable employee master record with change history (§3.5, §3.2).
5. Give each role a tailored dashboard and exportable reports (§3.8, §6).
6. Be secure by design: RBAC, hashed secrets, lockout, 2FA for privileged accounts, audit trail, company-email restriction (§5, §3.9).

## 3. Target users and roles (§2)

| Role                 | Summary              | Key capabilities                                                                                                                                               |
| -------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CEO**              | Full oversight       | Payroll configuration, executive approvals, all reports, all dashboards                                                                                        |
| **Executive**        | Department oversight | Monitor assigned departments' employees/attendance/projects; approve requests within authority; payroll summaries _subject to permission_                      |
| **HR**               | People operations    | Employee records, account provisioning, attendance monitoring & corrections, leave administration, overtime approval, payroll preparation, conflict resolution |
| **Staff / Employee** | Self-service         | Record attendance (PIN), manage own profile (permitted fields), apply for leave, view own attendance/payroll/tasks                                             |
| **IT Administrator** | System custodian     | System configuration, user access, security settings, account provisioning, temporary passwords, kiosk/device management                                       |

**Configurable permissions** are mandatory (§2): roles are data, permissions are fine-grained codes (e.g. `payroll.finalize`), and role→permission mappings are editable without code changes. The five roles above are **seeded defaults**, not hard-coded branches.

Additionally, **organisational hierarchy** (supervisor relationships, departments) is separate from RBAC: an employee's _supervisor_ is an approver for that employee regardless of the supervisor's role (§3.3).

### Indicative permission matrix (seed defaults, editable)

| Capability                                                       | CEO | Exec |      HR      | IT  |     Staff     |
| ---------------------------------------------------------------- | :-: | :--: | :----------: | :-: | :-----------: |
| Record own attendance (PIN kiosk)                                |  ✓  |  ✓   |      ✓       |  ✓  |       ✓       |
| View own attendance / payroll / leave                            |  ✓  |  ✓   |      ✓       |  ✓  |       ✓       |
| View all attendance                                              |  ✓  | dept |      ✓       |  –  |       –       |
| Correct attendance / resolve sync conflicts                      |  –  |  –   |      ✓       |  –  |       –       |
| Create / provision employee accounts                             |  –  |  –   |      ✓       |  ✓  |       –       |
| Edit sensitive employment data (position, classification)        |  ✓  |  –   |      ✓       |  –  |       –       |
| Edit compensation (hourly/OT rate)                               |  ✓  |  –   |      ✓       | ✓\* |       –       |
| Suspend / deactivate / reactivate accounts                       |  –  |  –   |      ✓       |  ✓  |       –       |
| Issue temporary password / reset PIN                             |  –  |  –   |      ✓       |  ✓  |       –       |
| Approve leave (as configured approver)                           |  ✓  |  ✓   |      ✓       |  –  | as supervisor |
| Approve overtime                                                 |  ✓  |  ✓   |      ✓       |  –  | as supervisor |
| Generate preliminary payroll                                     |  ✓  |  –   |      ✓       |  –  |       –       |
| Review / validate payroll                                        |  ✓  | ✓\*  |      ✓       |  –  |       –       |
| Finalize (lock) payroll                                          |  ✓  |  –   |      –       |  –  |       –       |
| Configure payroll policies (OT, undertime, deductions)           |  ✓  |  –   |     ✓\*      |  –  |       –       |
| Manage projects                                                  |  ✓  |  ✓   |      –       |  –  |       –       |
| Configure system (domains, timezone, schedules, approval chains) | ✓\* |  –   |     ✓\*      |  ✓  |       –       |
| Manage roles & permissions                                       |  –  |  –   |      –       |  ✓  |       –       |
| View audit logs                                                  |  ✓  |  –   | ✓ (HR scope) |  ✓  |       –       |

`*` = spec says "depending on assigned permissions"; seeded conservatively and editable. See **[Q-3]**.

## 4. Core modules

### M1 — Identity, Authentication & Access (§3.2, §3.9, §3.10, §5)

- **Purpose**: Two credential sets per employee: (A) account number + 6-digit PIN for attendance only; (B) account number + password for the system.
- **Rules**: account number immutable; employee can change PIN and password; self-service password recovery via registered company email; IT-issued temporary password that **expires after a configurable period** and **forces change on first use**; no public registration; company-email domain allow-list (configurable); all auth attempts logged; lockout/rate limit on repeated failures; **2FA (TOTP) mandatory for privileged roles**.
- **Exceptions**: locked account, expired temp password, suspended/deactivated account, wrong PIN, PIN brute-force on kiosk, reused/weak PIN (e.g. `000000`), session expiry.
- **Data**: `user_account`, `role`, `permission`, `role_permission`, `session/refresh_token`, `password_reset_token`, `auth_event`, `mfa_secret`.

### M2 — Employee & Organisation (§3.5, §3.10)

- **Purpose**: Master employee record, departments, positions, supervisor hierarchy.
- **Rules**: self-editable fields (contact number, address, emergency contact, personal email? — no, _company email only_ is registered) vs. restricted fields (position, classification, department, status, compensation). Every change logged with field-level history.
- **Lifecycle**: `PENDING_ACTIVATION → ACTIVE ⇄ SUSPENDED → DEACTIVATED → (reactivate) ACTIVE`. Deactivated/suspended employees can neither log in nor record attendance; history preserved (soft state, no deletes).
- **Data**: `employee`, `department`, `position`, `employee_change_history`, `emergency_contact`.

### M3 — Attendance (§3.1, §4)

- **Purpose**: PIN-based time-in/out on the landing page (no full login), automatic server timestamp, derived metrics (hours, late, undertime, overtime, absence, incomplete).
- **Rules**: prevent duplicate/invalid entries (e.g. time-in while already timed-in, time-out without time-in, rapid double-tap); deactivated accounts rejected; timestamps in company timezone (default **Asia/Manila, UTC+8**, §6).
- **Derived metrics require a work schedule** — see **[A-1]**.
- **Offline (§4)**: kiosk queues transactions in IndexedDB with a client UUID and original device timestamp; sync on reconnect with retries; server deduplicates by UUID, validates timestamps (clock-skew window), detects conflicts, never silently overwrites — conflicts are **flagged for HR review**; originals are immutable.
- **Data**: `attendance_event` (immutable raw punches, incl. source=online/offline, device, client UUID), `attendance_day` (derived/consolidated daily record), `attendance_conflict`, `attendance_adjustment` (HR corrections with reason, audit), `kiosk_device`, `sync_batch`.

### M4 — Leave (§3.3)

- **Types**: Vacation, Sick, Emergency, Maternity, Paternity, plus configurable custom types.
- **Fields**: employee, type, start/end date, computed day count, reason, supporting documents, submitted at, status.
- **Statuses**: `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`, `WITHDRAWN`. See **[A-4]** for the distinction.
- **Workflow**: multi-step approval chain configurable by admins (e.g. Supervisor → HR). Each step recorded. Final decision notifies the employee. Rejection reason visible to employee.
- **Rules**: no overlapping leave for the same employee (pending/approved); leave balances "if applicable" — see **[Q-1]**; concurrency-safe approvals (optimistic locking so two approvers can't double-act).
- **Data**: `leave_type`, `leave_request`, `leave_approval_step`, `leave_balance`, `approval_chain`, `approval_chain_step`, `attachment`.

### M5 — Overtime & Undertime Monitoring (§3.4, §3.6)

- **Purpose**: Track OT separately from regular hours; OT requires approval; only approved OT is payable; undertime thresholds/policies configurable; daily & monthly summaries; history of adjustments and approvals; feeds payroll automatically.
- **Data**: `overtime_record` (computed from attendance, status `PENDING/APPROVED/REJECTED`, approved minutes may be ≤ actual), `undertime_policy`.

### M6 — Payroll (§3.4)

- **Compensation profile** per employee: hourly rate, employment classification, OT rate (multiplier or absolute), undertime policy, payroll schedule, recurring adjustments. Versioned with effective dates so past payrolls stay reproducible.
- **Periods**: 15-day, semi-monthly (1–15, 16–EOM), monthly, custom range. (15-day vs semi-monthly differ: 15-day = rolling 15-day windows from an anchor date. **[A-6]**)
- **Formulas** (§3.4):
  - Regular pay = regular hours × hourly rate
  - OT pay = **approved** OT hours × OT hourly rate
  - Net = Regular + OT − Undertime deductions − Other deductions (+ allowances/adjustments)
- **Undertime policy options**: (a) hourly-rate equivalent, (b) fixed amount per N minutes (e.g. ₱50 per 30 min), (c) predefined company policy (tiered table).
- **Lifecycle**: `DRAFT (preliminary, generated by HR) → UNDER_REVIEW → VALIDATED → FINALIZED (locked)`; adjustments need permission and are audit-logged; finalized runs are immutable (corrections via a new adjustment run). Full computation breakdown stored per line for HR verification. Employees view their own payslips. Export PDF/XLSX.
- **Money**: integer centavos / `NUMERIC(14,2)` with decimal arithmetic — never floating point.
- **Data**: `compensation_profile`, `deduction_type`, `employee_deduction`, `payroll_run`, `payroll_line`, `payroll_line_item`, `payroll_adjustment`.

### M7 — Projects & Tasks (§3.7)

- Create/manage projects, assign members, tasks with assignee/deadline/priority/progress/status, project updates and remarks; visibility configurable by role/membership.
- **Data**: `project`, `project_member`, `task`, `project_update`.

### M8 — Dashboards (§3.8)

Role-specific dashboards (Employee, HR, Executive, CEO) built from the modules above. Dashboards are composed of permission-gated widgets so a custom role sees what its permissions allow.

### M9 — Reports & Export (§6)

Daily/weekly/monthly attendance, attendance history, leave applications & utilisation, overtime, undertime deductions, payroll summary, payslips, project progress, directory/org report. Filters: employee, department, position, date range. Formats: **PDF and XLSX**. Company timezone applies.

### M10 — Notifications (§3.3)

In-app notifications (required for leave decisions; also OT decisions, sync conflicts, payroll finalized). Email delivery via pluggable mailer — **[Q-5]**.

### M11 — Audit & Security Logging (§3.2, §3.5, §5)

Append-only audit log for sensitive actions (auth events, account changes, compensation edits, payroll adjustments, attendance corrections, conflict resolution, permission changes, sync activity). Readable by authorised roles; never stores secrets.

### M12 — System Configuration (§2, §3.3, §3.9, §6)

Company timezone, allowed email domains, work schedules, grace periods, undertime/OT policies, leave types, approval chains, temp-password TTL, lockout thresholds, 2FA enforcement per role, kiosk devices.

## 5. Business rules (consolidated)

| #     | Rule                                                                                                                                             | Source           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| BR-1  | Account number is unique, system-assigned, immutable                                                                                             | §3.1, §3.2, §3.5 |
| BR-2  | PIN is exactly 6 digits, hashed; used only for attendance                                                                                        | §3.2, §5         |
| BR-3  | Attendance timestamp is assigned by the server for online punches; offline punches keep the original device timestamp, validated on sync         | §3.1, §4         |
| BR-4  | No time-in while an open time-in exists; no time-out without an open time-in; repeat punches within a debounce window are rejected as duplicates | §3.1             |
| BR-5  | Suspended/deactivated accounts cannot log in or punch; history is preserved                                                                      | §3.10            |
| BR-6  | Only allow-listed company email domains may be registered                                                                                        | §3.9             |
| BR-7  | Temporary passwords expire after a configurable TTL and force change on first use                                                                | §3.2             |
| BR-8  | Privileged roles require 2FA                                                                                                                     | §3.9, §5         |
| BR-9  | Repeated failed logins/PINs trigger lockout or rate limiting                                                                                     | §5               |
| BR-10 | Leave requests for overlapping dates (pending or approved) are rejected                                                                          | §3.3             |
| BR-11 | Leave approval follows the configured chain; final approval only when all steps approve; any rejection ends the request                          | §3.3             |
| BR-12 | Only PENDING requests may be cancelled/withdrawn by the employee                                                                                 | §3.3             |
| BR-13 | Overtime is recorded separately and is payable only when approved                                                                                | §3.4             |
| BR-14 | Undertime deduction uses the employee's configured policy and is fully itemised                                                                  | §3.4             |
| BR-15 | Finalized payroll is locked; adjustments require permission and are audited                                                                      | §3.4             |
| BR-16 | Sensitive fields editable only by authorised roles; all employee changes are logged with history                                                 | §3.5             |
| BR-17 | Sync conflicts are flagged, never auto-overwritten; originals preserved                                                                          | §4               |
| BR-18 | All dates/times follow the configured company timezone (default Asia/Manila)                                                                     | §6               |
| BR-19 | No public registration; HR/IT provision accounts                                                                                                 | §3.9, §3.10      |

## 6. External dependencies

| Need                                                     | Proposed                                                    | Status                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Email (password recovery, temp passwords, notifications) | SMTP via Nodemailer (provider-agnostic)                     | **[Q-5]** credentials needed for production; dev uses a local catcher (Mailpit) |
| File storage (leave supporting documents, exports)       | Local disk in dev; S3-compatible in prod via a storage port | **[Q-6]**                                                                       |
| PDF generation                                           | Server-side (pdfmake / Playwright)                          | Decision in architecture                                                        |
| Spreadsheet export                                       | ExcelJS                                                     | —                                                                               |
| 2FA                                                      | TOTP (RFC 6238), authenticator apps                         | —                                                                               |

## 7. Technical constraints

- Web-based, modern browsers, responsive desktop/tablet/mobile (§7).
- Offline-capable attendance (§4) ⇒ PWA with service worker + IndexedDB.
- HTTPS everywhere (§5).
- Centralised database (§7) ⇒ single PostgreSQL instance.
- Automated backups and recovery (§5) ⇒ deployment concern; documented in architecture.
- Philippine context: PHP currency (₱), Asia/Manila default timezone.

## 8. Assumptions (non-critical, proceeding with safest reasonable default)

- **[A-1] Work schedules.** Late/undertime/overtime/absence need an expected schedule, which the spec does not define. Assume configurable **work schedules** (e.g. Mon–Fri 08:00–17:00, 60-min unpaid break, 15-min late grace) assigned per employee with a company default. Overtime = time worked beyond scheduled end (and on rest days); undertime = scheduled minutes not worked (early out); late = time-in after start + grace. Late minutes count toward undertime for deduction purposes unless the policy says otherwise.
- **[A-2] Single tenant.** One company per deployment (§1 "internal web-based platform", §3.9 "exclusively for internal company use"). No multi-tenant isolation layer; the schema keeps a company settings singleton.
- **[A-3] Holidays.** Not mentioned; a `holiday` calendar table is included so holidays are not counted as absences. Holiday pay premiums are **out of scope** until specified.
- **[A-4] Cancelled vs Withdrawn.** _Withdrawn_ = employee pulls back a PENDING request before any approval step acts. _Cancelled_ = request cancelled after partial approval or by HR/admin (e.g. approved leave revoked before it starts). Employee may cancel an APPROVED leave only if it has not started and only via HR approval — initial build: employee can withdraw PENDING; HR can cancel APPROVED future leave.
- **[A-5] Leave day count.** Counts working days per the employee's schedule, excluding rest days and holidays. Half-days are not supported initially.
- **[A-6] 15-day vs semi-monthly.** Semi-monthly = 1st–15th and 16th–end of month. 15-day = consecutive 15-day windows from a configured anchor date. Custom = any date range.
- **[A-7] Kiosk model.** Attendance landing page runs on IT-registered kiosk devices (device token) and also in any browser on the company network; offline punching is allowed only on registered kiosk devices, because offline mode cannot verify PINs online. See architecture §Offline security.
- **[A-8] Statutory deductions** (SSS, PhilHealth, Pag-IBIG, withholding tax) are modelled as **configurable deduction types** (fixed or percentage) rather than hard-coded government tables. See **[Q-2]**.
- **[A-9] Payroll eligibility.** Paid leave adds regular hours to payroll (8h/day or scheduled hours) when the leave type is marked _paid_; unpaid leave does not.
- **[A-11] Privileged role assignment.** Roles that require 2FA or grant access management (CEO, Executive, HR, IT by default) can only be assigned, changed, or have their holders suspended, by users with `access.manage` (IT). HR provisions and manages Staff-level accounts. Nobody can change their own role or account status. This prevents privilege escalation through the provisioning screen.
- **[A-10] Supervisor approval of OT** follows the same supervisor relationship used for leave, falling back to HR.

## 9. Open questions (to confirm with the project owner)

| ID  | Module        | Question                                                                                                             | Why it matters                               | Default used meanwhile                                                                    |
| --- | ------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Q-1 | Leave         | Are there leave credits/balances (e.g. 15 VL/yr), accrual rules, carry-over?                                         | Changes leave validation and dashboards      | Balances table exists; validation only if a balance is configured for that type           |
| Q-2 | Payroll       | Should Philippine statutory contributions and withholding tax be computed automatically from official tables?        | Significant payroll logic and legal accuracy | Configurable deduction types (manual amounts/percentages)                                 |
| Q-3 | RBAC          | Can Executives see individual payroll amounts, or only aggregates? Can IT edit pay rates?                            | Sensitive-data exposure                      | Executives see aggregates only; IT cannot edit pay rates                                  |
| Q-4 | Attendance    | Can employees punch from personal phones, or only company kiosks/network? Geofence/IP restriction?                   | Security of PIN-only attendance              | Registered kiosks + company-network browsers                                              |
| Q-5 | Notifications | SMTP provider and sender address for production email?                                                               | Password recovery and notifications          | Dev mail catcher                                                                          |
| Q-6 | Deployment    | Hosting target (VPS/Docker, cloud provider)? Backup policy (RPO/RTO)?                                                | Deployment & backups                         | Docker Compose reference deployment                                                       |
| Q-7 | Payroll       | Is overtime rate a multiplier of hourly rate (e.g. 1.25×) or a fixed amount? Night differential / rest-day premiums? | Payroll accuracy                             | Per-profile choice: multiplier (default 1.25×) or fixed rate; no ND/rest-day premiums yet |
| Q-8 | Attendance    | Multiple time-in/out pairs per day (e.g. lunch out/in), and overnight shifts?                                        | Attendance model                             | Multiple pairs per day supported; shifts crossing midnight attributed to the start date   |

No unresolved contradictions were found between sections of the specification.
