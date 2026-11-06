-- CreateEnum
CREATE TYPE "attendance_correction_type" AS ENUM ('CHANGE_TIME_IN', 'CHANGE_TIME_OUT', 'MISSING_TIME_IN', 'MISSING_TIME_OUT', 'INCORRECT_TIMESTAMP', 'OTHER');

-- CreateEnum
CREATE TYPE "attendance_correction_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "attendance_correction_request" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "type" "attendance_correction_type" NOT NULL,
    "punch_type" "attendance_event_type",
    "target_event_id" UUID,
    "original_at" TIMESTAMPTZ(3),
    "requested_at" TIMESTAMPTZ(3),
    "reason" VARCHAR(1000) NOT NULL,
    "status" "attendance_correction_status" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_id" UUID,
    "decision_note" VARCHAR(500),
    "applied_event_id" UUID,
    "voided_event_id" UUID,
    "applied_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_correction_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_correction_step" (
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

    CONSTRAINT "attendance_correction_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" VARCHAR(50) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "link" VARCHAR(300),
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_correction_request_employee_id_submitted_at_idx" ON "attendance_correction_request"("employee_id", "submitted_at");

-- CreateIndex
CREATE INDEX "attendance_correction_request_status_idx" ON "attendance_correction_request"("status");

-- CreateIndex
CREATE INDEX "attendance_correction_step_approver_employee_id_status_idx" ON "attendance_correction_step"("approver_employee_id", "status");

-- CreateIndex
CREATE INDEX "attendance_correction_step_approver_role_id_status_idx" ON "attendance_correction_step"("approver_role_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_correction_step_request_id_position_key" ON "attendance_correction_step"("request_id", "position");

-- CreateIndex
CREATE INDEX "notification_user_id_created_at_idx" ON "notification"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "attendance_correction_request" ADD CONSTRAINT "attendance_correction_request_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_correction_request" ADD CONSTRAINT "attendance_correction_request_target_event_id_fkey" FOREIGN KEY ("target_event_id") REFERENCES "attendance_event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_correction_step" ADD CONSTRAINT "attendance_correction_step_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "attendance_correction_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_correction_step" ADD CONSTRAINT "attendance_correction_step_approver_employee_id_fkey" FOREIGN KEY ("approver_employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_correction_step" ADD CONSTRAINT "attendance_correction_step_approver_role_id_fkey" FOREIGN KEY ("approver_role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One open request per record and kind: a second identical request would only race the first.
CREATE UNIQUE INDEX "attendance_correction_one_pending"
  ON "attendance_correction_request" ("employee_id", "work_date", "type")
  WHERE "status" = 'PENDING';

-- Requested values and decisions are evidence: requests and their steps are never deleted, and
-- what was originally asked (and when) cannot be rewritten afterwards.
CREATE FUNCTION protect_attendance_correction() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.work_date IS DISTINCT FROM OLD.work_date
     OR NEW.type IS DISTINCT FROM OLD.type OR NEW.target_event_id IS DISTINCT FROM OLD.target_event_id
     OR NEW.original_at IS DISTINCT FROM OLD.original_at OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'attendance_correction_request submitted fields are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER attendance_correction_request_protect BEFORE UPDATE OR DELETE ON "attendance_correction_request"
  FOR EACH ROW EXECUTE FUNCTION protect_attendance_correction();
CREATE TRIGGER attendance_correction_step_protect BEFORE DELETE ON "attendance_correction_step"
  FOR EACH ROW EXECUTE FUNCTION protect_leave_history();
