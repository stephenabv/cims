#!/usr/bin/env bash
# Vercel build step for CIMS: compile everything, then (production only) migrate and seed.
# Migrations run after a successful compile so a broken build never touches the database.
set -euo pipefail

pnpm build

if [[ "${VERCEL_ENV:-}" != "production" ]]; then
  echo "VERCEL_ENV=${VERCEL_ENV:-unset}: skipping database migrations and seed."
  exit 0
fi

# Migrations need a direct (non-pooled) connection; the Neon integration provides one.
MIGRATION_URL="${DATABASE_URL_UNPOOLED:-${DATABASE_URL:-}}"
if [[ -z "${MIGRATION_URL}" ]]; then
  echo "DATABASE_URL is not set. Connect the Neon database to this Vercel project first." >&2
  exit 1
fi

echo "Applying database migrations..."
DATABASE_URL="${MIGRATION_URL}" pnpm --filter @cims/api exec prisma migrate deploy

# Idempotent: refreshes permissions/roles and creates the first IT administrator only once.
echo "Seeding reference data..."
DATABASE_URL="${MIGRATION_URL}" pnpm --filter @cims/api seed
