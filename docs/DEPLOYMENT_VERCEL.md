# Deploying CIMS to Vercel

CIMS runs as **one Vercel project**: the React PWA is served as static files and the NestJS API
runs as a single Vercel Function behind `/api/*`. Web and API share one origin, so session and
CSRF cookies work exactly as in local development (no cross-site cookies, no CORS exposure).
The database is **Neon Postgres** from the Vercel Marketplace (free plan).

```
browser ──► Vercel CDN ──► apps/web/dist (static PWA)
                     └──► /api/*  ──► api/index.mjs ──► apps/api/dist (NestJS) ──► Neon Postgres
```

| File                                    | Purpose                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `vercel.json`                           | Build/output settings, `/api` rewrite, SPA fallback, headers, region      |
| `scripts/vercel-build.sh`               | Builds everything; on production also runs `prisma migrate deploy` + seed |
| `api/index.mjs`                         | The Vercel Function; delegates to the compiled Nest app                   |
| `apps/api/src/serverless/handler.ts`    | Boots Nest once per instance with the same hardening as `main.ts`         |
| `apps/api/src/serverless/vercel-env.ts` | Derives `WEB_ORIGIN`, `TRUST_PROXY_HOPS`, `COOKIE_SECURE` on Vercel       |

## One-time setup

1. **Project.** Import `stephenabv/cims` in Vercel (root directory = repository root). All build
   settings come from `vercel.json`; leave the framework preset as "Other".
2. **Database.** Project → _Storage_ → _Create Database_ → **Neon** → Free plan, region
   **Singapore (aws-ap-southeast-1)** to sit next to the function region (`sin1`). Connect it to
   the project for the **Production** environment. This adds `DATABASE_URL` (pooled) and
   `DATABASE_URL_UNPOOLED` (direct, used for migrations).
3. **Environment variables** (Production, mark secrets as _Sensitive_):

   | Variable                                                                                | Value                                                                                   |
   | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
   | `NODE_ENV`                                                                              | `production` (install uses `--prod=false`, so build tools still install)                |
   | `CSRF_SECRET`                                                                           | `openssl rand -base64 48`                                                               |
   | `DATA_ENCRYPTION_KEY`                                                                   | `openssl rand -base64 32` (never change after go-live: it decrypts stored TOTP secrets) |
   | `BOOTSTRAP_ADMIN_EMAIL`                                                                 | First IT administrator's company e-mail (its domain becomes the allowed sign-in domain) |
   | `BOOTSTRAP_ADMIN_PASSWORD`                                                              | Strong temporary password; forced to change at first sign-in                            |
   | `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASSWORD` / `MAIL_FROM` | A real mail provider. Without it, e-mails (temporary passwords, notifications) fail.    |

   Optional: `WEB_ORIGIN` (defaults to `https://<production domain>`; set it when you add a custom
   domain), `LOG_LEVEL`.

4. **Deploy** (push to `main` or _Redeploy_). The production build compiles, then applies
   migrations and seeds roles, permissions, the default approval chain and the first IT admin.
   The admin's account number is printed in the build log.
5. Check `https://<domain>/api/v1/health` returns `{"status":"ok","database":"up"}`.

## Operational notes

- **Previews are skipped** (`ignoreCommand`): only production builds run, because the database is
  production-only. To enable previews later, enable Neon's "create a branch per preview" option,
  scope the DB variables to Preview, and remove `ignoreCommand`.
- **Migrations run during the production build**, after a successful compile. They must stay
  backward compatible with the previous release (expand, then contract), because the old version
  keeps serving until the new deployment is promoted.
- **Rate limiting** (`@nestjs/throttler`) is in-memory, so limits apply per function instance.
  Combine with Vercel Firewall rate-limit rules for login/kiosk endpoints if abuse appears.
- **Background jobs**: none are scheduled yet. When one is added, expose it as an authenticated
  endpoint and trigger it with Vercel Cron (`crons` in `vercel.json`) instead of `@nestjs/schedule`,
  which does not run between requests on serverless.
- **Free-plan limits**: Neon free suspends compute when idle (first request after idle is slower)
  and caps storage; Vercel Hobby is for non-commercial use. Move to paid plans before relying on
  it for real payroll.
- **Rollback**: _Instant Rollback_ in Vercel restores the previous build; it does not roll back
  the database, which is why migrations must be backward compatible.
