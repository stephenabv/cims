# CIMS — Company Information Management System

Internal platform for attendance (PIN kiosk with offline sync), leave, overtime/undertime, payroll,
employee records and project tracking.

- Requirements, assumptions and open questions: [`docs/PROJECT_ANALYSIS.md`](docs/PROJECT_ANALYSIS.md)
- Architecture and security design: [`docs/SYSTEM_ARCHITECTURE.md`](docs/SYSTEM_ARCHITECTURE.md)
- Phased plan: [`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md)
- Current status: [`docs/IMPLEMENTATION_TRACKER.md`](docs/IMPLEMENTATION_TRACKER.md)

## Stack

| Layer   | Technology                                                                 |
| ------- | -------------------------------------------------------------------------- |
| API     | NestJS 11, Prisma 6, PostgreSQL 16, argon2id, TOTP                         |
| Web     | React 19, Vite, TanStack Query, react-hook-form + zod, Tailwind CSS 4, PWA |
| Shared  | `@cims/shared` — permission codes, enums and zod schemas used by both      |
| Tooling | pnpm workspaces, TypeScript strict, ESLint, Prettier, Jest, Vitest         |

## Getting started

Requirements: Node 22+, pnpm 10, Docker (or a local PostgreSQL 16).

```bash
pnpm install
pnpm db:up                                   # postgres on :5432, mailpit on :1025 (UI http://localhost:8025)
cp apps/api/.env.example apps/api/.env       # then fill DATA_ENCRYPTION_KEY, CSRF_SECRET, BOOTSTRAP_ADMIN_*
pnpm --filter @cims/shared build
pnpm --filter @cims/api prisma:deploy        # apply migrations
pnpm --filter @cims/api seed                 # roles, permissions, bootstrap IT administrator
pnpm dev:api                                 # http://localhost:3000/api/v1
pnpm dev:web                                 # http://localhost:5173 (proxies /api to the API)
```

The seed prints the bootstrap administrator's account number (normally `EMP-000001`). On first
sign-in the administrator must enrol two-factor authentication and replace the bootstrap password.
Emails (password resets, temporary passwords) appear in Mailpit during development.

## Quality gates

```bash
pnpm lint && pnpm format:check
pnpm typecheck
pnpm test        # unit + integration; integration tests need PostgreSQL (database cims_test)
pnpm build
```

Integration tests rebuild the `cims_test` database from migrations on every run and refuse to run
against a database whose name does not end in `_test`. Override the location with
`TEST_DATABASE_URL`.

## Repository layout

```
apps/api        NestJS API (modules/<feature>, common/, infrastructure/, prisma/)
apps/web        React PWA (features/<feature>, components/ui, lib/)
packages/shared Shared contracts
docs/           Planning and architecture documents
```
