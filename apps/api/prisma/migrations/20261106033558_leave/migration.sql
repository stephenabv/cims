-- CreateEnum
CREATE TYPE "leave_request_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "approval_step_kind" AS ENUM ('SUPERVISOR', 'DEPARTMENT_HEAD', 'ROLE', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "leave_step_status" AS ENUM ('WAITING', 'PENDING', 'APPROVED', 'REJECTED', 'SKIPPED', 'CANCELLED');

-- CreateTable
CREATE TABLE "leave_type" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_paid" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "approval_chain_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leave_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_chain" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "approval_chain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_chain_step" (
    "id" UUID NOT NULL,
    "chain_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "approval_step_kind" NOT NULL,
    "role_id" UUID,
    "employee_id" UUID,

    CONSTRAINT "approval_chain_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_request" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "days" INTEGER NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "status" "leave_request_status" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "ended_by_id" UUID,
    "end_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leave_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_request_day" (
    "request_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "date" DATE NOT NULL,

    CONSTRAINT "leave_request_day_pkey" PRIMARY KEY ("request_id","date")
);

-- CreateTable
CREATE TABLE "leave_approval_step" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "approval_step_kind" NOT NULL,
    "approver_employee_id" UUID,
    "approver_role_id" UUID,
    "status" "leave_step_status" NOT NULL,
    "acted_by_id" UUID,
    "acted_at" TIMESTAMPTZ(3),
    "note" VARCHAR(500),

    CONSTRAINT "leave_approval_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_balance" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "allotted_days" INTEGER NOT NULL,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leave_balance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leave_type_code_key" ON "leave_type"("code");

-- CreateIndex
CREATE UNIQUE INDEX "leave_type_name_key" ON "leave_type"("name");

-- CreateIndex
CREATE UNIQUE INDEX "approval_chain_name_key" ON "approval_chain"("name");

-- CreateIndex
CREATE UNIQUE INDEX "approval_chain_step_chain_id_position_key" ON "approval_chain_step"("chain_id", "position");

-- CreateIndex
CREATE INDEX "leave_request_employee_id_start_date_idx" ON "leave_request"("employee_id", "start_date");

-- CreateIndex
CREATE INDEX "leave_request_status_idx" ON "leave_request"("status");

-- CreateIndex
CREATE INDEX "leave_request_day_employee_id_date_idx" ON "leave_request_day"("employee_id", "date");

-- CreateIndex
CREATE INDEX "leave_approval_step_approver_employee_id_status_idx" ON "leave_approval_step"("approver_employee_id", "status");

-- CreateIndex
CREATE INDEX "leave_approval_step_approver_role_id_status_idx" ON "leave_approval_step"("approver_role_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "leave_approval_step_request_id_position_key" ON "leave_approval_step"("request_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "leave_balance_employee_id_leave_type_id_year_key" ON "leave_balance"("employee_id", "leave_type_id", "year");

-- AddForeignKey
ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_approval_chain_id_fkey" FOREIGN KEY ("approval_chain_id") REFERENCES "approval_chain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_chain_step" ADD CONSTRAINT "approval_chain_step_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "approval_chain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_chain_step" ADD CONSTRAINT "approval_chain_step_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_chain_step" ADD CONSTRAINT "approval_chain_step_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "leave_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request_day" ADD CONSTRAINT "leave_request_day_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "leave_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request_day" ADD CONSTRAINT "leave_request_day_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_approval_step" ADD CONSTRAINT "leave_approval_step_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "leave_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_approval_step" ADD CONSTRAINT "leave_approval_step_approver_employee_id_fkey" FOREIGN KEY ("approver_employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_approval_step" ADD CONSTRAINT "leave_approval_step_approver_role_id_fkey" FOREIGN KEY ("approver_role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balance" ADD CONSTRAINT "leave_balance_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balance" ADD CONSTRAINT "leave_balance_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "leave_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Hand-written constraints and seed data ────────────────────────────────────

-- Second line of defence against overlapping leave (BR-10); the service also checks under a row lock.
-- btree_gist is a trusted extension (PostgreSQL 13+): the database owner can create it.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_dates_check" CHECK (end_date >= start_date AND days > 0);
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_no_overlap"
  EXCLUDE USING gist (employee_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
  WHERE (status IN ('PENDING', 'APPROVED'));
ALTER TABLE "leave_balance" ADD CONSTRAINT "leave_balance_values_check"
  CHECK (allotted_days >= 0 AND allotted_days <= 366 AND year BETWEEN 2000 AND 2100);
ALTER TABLE "approval_chain_step" ADD CONSTRAINT "approval_chain_step_target_check" CHECK (
  (kind = 'ROLE' AND role_id IS NOT NULL AND employee_id IS NULL) OR
  (kind = 'EMPLOYEE' AND employee_id IS NOT NULL AND role_id IS NULL) OR
  (kind IN ('SUPERVISOR', 'DEPARTMENT_HEAD') AND role_id IS NULL AND employee_id IS NULL)
);
CREATE UNIQUE INDEX "approval_chain_single_default" ON "approval_chain" (is_default) WHERE is_default;

-- Approval history is permanent.
CREATE FUNCTION protect_leave_history() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER leave_request_protect BEFORE DELETE ON "leave_request"
  FOR EACH ROW EXECUTE FUNCTION protect_leave_history();
CREATE TRIGGER leave_approval_step_protect BEFORE DELETE ON "leave_approval_step"
  FOR EACH ROW EXECUTE FUNCTION protect_leave_history();

-- The default approval chain (Supervisor then HR) is created by prisma/seed.ts, after roles exist.

-- Leave types named in the spec (§3.3). All paid by default; HR can change this.
INSERT INTO "leave_type" (id, code, name, is_paid, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000121', 'VL', 'Vacation leave', true, now()),
  ('00000000-0000-4000-8000-000000000122', 'SL', 'Sick leave', true, now()),
  ('00000000-0000-4000-8000-000000000123', 'EL', 'Emergency leave', true, now()),
  ('00000000-0000-4000-8000-000000000124', 'ML', 'Maternity leave', true, now()),
  ('00000000-0000-4000-8000-000000000125', 'PL', 'Paternity leave', true, now());
