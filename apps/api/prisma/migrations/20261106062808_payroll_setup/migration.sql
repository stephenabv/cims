-- CreateEnum
CREATE TYPE "undertime_policy_kind" AS ENUM ('HOURLY_EQUIVALENT', 'FIXED_PER_BLOCK', 'TIERED');

-- CreateEnum
CREATE TYPE "overtime_rate_kind" AS ENUM ('MULTIPLIER', 'FIXED');

-- CreateEnum
CREATE TYPE "pay_schedule" AS ENUM ('SEMI_MONTHLY', 'ROLLING_15_DAY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "pay_item_direction" AS ENUM ('ALLOWANCE', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "pay_item_calculation" AS ENUM ('FIXED', 'PERCENT_OF_GROSS');

-- CreateTable
CREATE TABLE "undertime_policy" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "kind" "undertime_policy_kind" NOT NULL,
    "block_minutes" INTEGER,
    "amount_per_block_centavos" INTEGER,
    "charge_partial_block" BOOLEAN NOT NULL DEFAULT true,
    "tiers" JSONB,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "undertime_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensation_profile" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "hourly_rate_centavos" INTEGER NOT NULL,
    "overtime_rate_kind" "overtime_rate_kind" NOT NULL,
    "overtime_multiplier_permille" INTEGER,
    "overtime_fixed_rate_centavos" INTEGER,
    "undertime_policy_id" UUID NOT NULL,
    "pay_schedule" "pay_schedule" NOT NULL,
    "note" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compensation_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_item_type" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "direction" "pay_item_direction" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pay_item_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_pay_item" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "calculation" "pay_item_calculation" NOT NULL,
    "amount_centavos" INTEGER,
    "rate_basis_points" INTEGER,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "note" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employee_pay_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "undertime_policy_name_key" ON "undertime_policy"("name");

-- CreateIndex
CREATE UNIQUE INDEX "compensation_profile_employee_id_effective_from_key" ON "compensation_profile"("employee_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "pay_item_type_code_key" ON "pay_item_type"("code");

-- CreateIndex
CREATE UNIQUE INDEX "pay_item_type_name_key" ON "pay_item_type"("name");

-- CreateIndex
CREATE INDEX "employee_pay_item_employee_id_effective_from_idx" ON "employee_pay_item"("employee_id", "effective_from");

-- AddForeignKey
ALTER TABLE "compensation_profile" ADD CONSTRAINT "compensation_profile_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_profile" ADD CONSTRAINT "compensation_profile_undertime_policy_id_fkey" FOREIGN KEY ("undertime_policy_id") REFERENCES "undertime_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_pay_item" ADD CONSTRAINT "employee_pay_item_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_pay_item" ADD CONSTRAINT "employee_pay_item_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "pay_item_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written ---------------------------------------------------------------

ALTER TABLE "undertime_policy" ADD CONSTRAINT "undertime_policy_kind_check" CHECK (
  (kind <> 'FIXED_PER_BLOCK' OR (block_minutes BETWEEN 1 AND 480 AND amount_per_block_centavos >= 0))
  AND (kind <> 'TIERED' OR jsonb_typeof(tiers) = 'array')
);
CREATE UNIQUE INDEX "undertime_policy_single_default" ON "undertime_policy" (is_default) WHERE is_default;

ALTER TABLE "compensation_profile" ADD CONSTRAINT "compensation_profile_values_check" CHECK (
  hourly_rate_centavos > 0
  AND (
    (overtime_rate_kind = 'MULTIPLIER' AND overtime_multiplier_permille BETWEEN 1000 AND 5000
      AND overtime_fixed_rate_centavos IS NULL)
    OR (overtime_rate_kind = 'FIXED' AND overtime_fixed_rate_centavos > 0
      AND overtime_multiplier_permille IS NULL)
  )
);
-- Versions are never edited; a change is a new version.
CREATE TRIGGER compensation_profile_no_update BEFORE UPDATE ON "compensation_profile"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

ALTER TABLE "employee_pay_item" ADD CONSTRAINT "employee_pay_item_values_check" CHECK (
  ((calculation = 'FIXED' AND amount_centavos > 0 AND rate_basis_points IS NULL)
    OR (calculation = 'PERCENT_OF_GROSS' AND rate_basis_points BETWEEN 1 AND 10000 AND amount_centavos IS NULL))
  AND (effective_to IS NULL OR effective_to >= effective_from)
);

-- Defaults: undertime at the hourly-rate equivalent, and the usual Philippine deductions (Q-2:
-- amounts are configured per employee, not computed from government tables).
INSERT INTO "undertime_policy" (id, name, kind, is_default, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000131', 'Hourly-rate equivalent', 'HOURLY_EQUIVALENT', true, now());
INSERT INTO "pay_item_type" (id, code, name, direction, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000141', 'SSS', 'SSS contribution', 'DEDUCTION', now()),
  ('00000000-0000-4000-8000-000000000142', 'PHIC', 'PhilHealth contribution', 'DEDUCTION', now()),
  ('00000000-0000-4000-8000-000000000143', 'HDMF', 'Pag-IBIG contribution', 'DEDUCTION', now()),
  ('00000000-0000-4000-8000-000000000144', 'WTAX', 'Withholding tax', 'DEDUCTION', now());
