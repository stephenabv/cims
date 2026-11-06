-- CreateEnum
CREATE TYPE "overtime_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'VOIDED');

-- CreateEnum
CREATE TYPE "overtime_action" AS ENUM ('APPROVE', 'REJECT', 'REOPEN', 'VOID');

-- CreateTable
CREATE TABLE "overtime_record" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "actual_minutes" INTEGER NOT NULL,
    "approved_minutes" INTEGER,
    "status" "overtime_status" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "overtime_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_history" (
    "id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "action" "overtime_action" NOT NULL,
    "minutes" INTEGER,
    "note" VARCHAR(500),
    "acted_by_id" UUID,
    "acted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "overtime_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "overtime_record_work_date_status_idx" ON "overtime_record"("work_date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "overtime_record_employee_id_work_date_key" ON "overtime_record"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "overtime_history_record_id_acted_at_idx" ON "overtime_history"("record_id", "acted_at");

-- AddForeignKey
ALTER TABLE "overtime_record" ADD CONSTRAINT "overtime_record_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_history" ADD CONSTRAINT "overtime_history_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "overtime_record"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written ---------------------------------------------------------------

ALTER TABLE "overtime_record" ADD CONSTRAINT "overtime_record_minutes_check" CHECK (
  actual_minutes >= 0
  AND (approved_minutes IS NULL OR (approved_minutes > 0 AND approved_minutes <= actual_minutes))
  AND ((status = 'APPROVED') = (approved_minutes IS NOT NULL))
);
ALTER TABLE "overtime_history" ADD CONSTRAINT "overtime_history_minutes_check" CHECK (
  minutes IS NULL OR minutes >= 0
);

-- Decision history is permanent. A record with history cannot be deleted (foreign key RESTRICT).
CREATE TRIGGER overtime_history_append_only BEFORE UPDATE OR DELETE ON "overtime_history"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Overtime already recorded before this release becomes pending records (default minimum: 30).
INSERT INTO "overtime_record" (id, employee_id, work_date, actual_minutes, updated_at)
SELECT gen_random_uuid(), employee_id, work_date, overtime_minutes, now()
FROM "attendance_day"
WHERE overtime_minutes >= 30 AND status <> 'INCOMPLETE' AND NOT has_open_punch;
