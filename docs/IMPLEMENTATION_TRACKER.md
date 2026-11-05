# CIMS — Implementation Tracker

Statuses: NOT STARTED · IN PROGRESS · IMPLEMENTED · TESTING · COMPLETED · BLOCKED

_Last updated: 2026-11-05_

| #   | Feature / module                                             | Status      | Depends on | Outstanding tasks        | Testing | Known issues | Notes                                            |
| --- | ------------------------------------------------------------ | ----------- | ---------- | ------------------------ | ------- | ------------ | ------------------------------------------------ |
| P1  | Repository discovery                                         | COMPLETED   | –          | –                        | n/a     | –            | Repo empty; spec DOCX is the only source         |
| P2  | Requirements & architecture docs                             | COMPLETED   | P1         | Owner answers to Q-1…Q-8 | n/a     | –            | Stack confirmed: NestJS + React PWA + PostgreSQL |
| P3  | Foundation (monorepo, config, Prisma, test harness, CI)      | IN PROGRESS | P2         |                          |         |              |                                                  |
| P4  | Auth, sessions, lockout, CSRF, temp passwords, recovery, 2FA | NOT STARTED | P3         |                          |         |              |                                                  |
| P4b | Roles & permissions admin                                    | NOT STARTED | P4         |                          |         |              |                                                  |
| P4c | Audit log service + viewer                                   | NOT STARTED | P3         |                          |         |              |                                                  |
| P5  | Employees, departments, positions, hierarchy                 | NOT STARTED | P4         |                          |         |              |                                                  |
| P5b | Account provisioning & lifecycle                             | NOT STARTED | P5         |                          |         |              |                                                  |
| P5c | Profile self-service & change history                        | NOT STARTED | P5         |                          |         |              |                                                  |
| P5d | Company settings (domains, timezone, security)               | NOT STARTED | P3         |                          |         |              |                                                  |
| P6  | Work schedules & holidays                                    | NOT STARTED | P5         |                          |         |              | Assumption A-1                                   |
| P6b | Kiosk devices & PIN punch                                    | NOT STARTED | P5, P6     |                          |         |              |                                                  |
| P6c | Attendance calculator & daily records                        | NOT STARTED | P6         |                          |         |              |                                                  |
| P6d | Attendance history / HR monitor / adjustments                | NOT STARTED | P6c        |                          |         |              |                                                  |
| P7  | Offline outbox & sync, conflict review                       | NOT STARTED | P6b        |                          |         |              |                                                  |
| P8  | Leave types, chains, requests, approvals, balances           | NOT STARTED | P5, P6     |                          |         |              | Q-1 open                                         |
| P9  | Overtime / undertime monitoring                              | NOT STARTED | P6c        |                          |         |              |                                                  |
| P10 | Payroll (compensation, deductions, runs, payslips)           | NOT STARTED | P8, P9     |                          |         |              | Q-2, Q-7 open                                    |
| P11 | Projects & tasks                                             | NOT STARTED | P5         |                          |         |              |                                                  |
| P12 | Dashboards & notifications                                   | NOT STARTED | P6–P11     |                          |         |              |                                                  |
| P13 | Reports & exports (PDF/XLSX)                                 | NOT STARTED | P6–P11     |                          |         |              |                                                  |
| P14 | Hardening, a11y, deployment, backups                         | NOT STARTED | all        |                          |         |              | Q-6 open                                         |
