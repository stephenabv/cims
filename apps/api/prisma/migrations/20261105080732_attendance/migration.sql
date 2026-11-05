-- CreateEnum
CREATE TYPE "attendance_event_type" AS ENUM ('TIME_IN', 'TIME_OUT');

-- CreateEnum
CREATE TYPE "attendance_event_source" AS ENUM ('KIOSK_ONLINE', 'KIOSK_OFFLINE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "attendance_event_status" AS ENUM ('ACCEPTED', 'VOIDED', 'CONFLICT');

-- CreateEnum
CREATE TYPE "attendance_day_status" AS ENUM ('PRESENT', 'LATE', 'INCOMPLETE', 'REST_DAY_WORKED', 'HOLIDAY_WORKED');

-- AlterTable
ALTER TABLE "employee" ADD COLUMN     "work_schedule_id" UUID;

-- CreateTable
CREATE TABLE "work_schedule" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "grace_minutes" INTEGER NOT NULL DEFAULT 15,
    "break_minutes" INTEGER NOT NULL DEFAULT 60,
    "break_threshold_minutes" INTEGER NOT NULL DEFAULT 240,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "work_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_schedule_day" (
    "schedule_id" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "start_minute" SMALLINT NOT NULL,
    "end_minute" SMALLINT NOT NULL,

    CONSTRAINT "work_schedule_day_pkey" PRIMARY KEY ("schedule_id","weekday")
);

-- CreateTable
CREATE TABLE "holiday" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kiosk_device" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_by_id" UUID,
    "last_seen_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kiosk_device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_event" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "type" "attendance_event_type" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "work_date" DATE NOT NULL,
    "source" "attendance_event_source" NOT NULL,
    "status" "attendance_event_status" NOT NULL DEFAULT 'ACCEPTED',
    "device_id" UUID,
    "client_uuid" UUID,
    "created_by_id" UUID,
    "note" VARCHAR(500),
    "voided_by_id" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" VARCHAR(500),

    CONSTRAINT "attendance_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_day" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "first_in" TIMESTAMPTZ(3),
    "last_out" TIMESTAMPTZ(3),
    "worked_minutes" INTEGER NOT NULL DEFAULT 0,
    "regular_minutes" INTEGER NOT NULL DEFAULT 0,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "undertime_minutes" INTEGER NOT NULL DEFAULT 0,
    "overtime_minutes" INTEGER NOT NULL DEFAULT 0,
    "scheduled_minutes" INTEGER NOT NULL DEFAULT 0,
    "status" "attendance_day_status" NOT NULL,
    "has_open_punch" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_day_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "work_schedule_name_key" ON "work_schedule"("name");

-- CreateIndex
CREATE UNIQUE INDEX "holiday_date_key" ON "holiday"("date");

-- CreateIndex
CREATE UNIQUE INDEX "kiosk_device_token_hash_key" ON "kiosk_device"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_event_client_uuid_key" ON "attendance_event"("client_uuid");

-- CreateIndex
CREATE INDEX "attendance_event_employee_id_occurred_at_idx" ON "attendance_event"("employee_id", "occurred_at");

-- CreateIndex
CREATE INDEX "attendance_event_employee_id_work_date_idx" ON "attendance_event"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "attendance_event_work_date_idx" ON "attendance_event"("work_date");

-- CreateIndex
CREATE INDEX "attendance_day_work_date_idx" ON "attendance_day"("work_date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_day_employee_id_work_date_key" ON "attendance_day"("employee_id", "work_date");

-- AddForeignKey
ALTER TABLE "employee" ADD CONSTRAINT "employee_work_schedule_id_fkey" FOREIGN KEY ("work_schedule_id") REFERENCES "work_schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_schedule_day" ADD CONSTRAINT "work_schedule_day_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "work_schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_event" ADD CONSTRAINT "attendance_event_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_event" ADD CONSTRAINT "attendance_event_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "kiosk_device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_day" ADD CONSTRAINT "attendance_day_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────── Hand-written constraints ─────────────

CREATE UNIQUE INDEX "work_schedule_single_default" ON "work_schedule" ((is_default)) WHERE is_default;
ALTER TABLE "work_schedule" ADD CONSTRAINT "work_schedule_minutes_valid"
  CHECK (grace_minutes BETWEEN 0 AND 240 AND break_minutes BETWEEN 0 AND 240 AND break_threshold_minutes BETWEEN 0 AND 1440);
-- Overnight shifts end after midnight (end up to 48h); they belong to the start date (Q-8 default).
ALTER TABLE "work_schedule_day" ADD CONSTRAINT "work_schedule_day_valid"
  CHECK (weekday BETWEEN 1 AND 7 AND start_minute >= 0 AND start_minute < 1440 AND end_minute > start_minute AND end_minute <= 2880);
ALTER TABLE "attendance_day" ADD CONSTRAINT "attendance_day_minutes_nonnegative"
  CHECK (worked_minutes >= 0 AND regular_minutes >= 0 AND late_minutes >= 0 AND undertime_minutes >= 0 AND overtime_minutes >= 0);

-- Raw punches are immutable evidence: no deletes, and only the void fields/status may change.
CREATE FUNCTION protect_attendance_event() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attendance_event rows cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.client_uuid IS DISTINCT FROM OLD.client_uuid OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'attendance_event core fields are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER attendance_event_protect BEFORE UPDATE OR DELETE ON "attendance_event"
  FOR EACH ROW EXECUTE FUNCTION protect_attendance_event();

-- Company default schedule: Monday–Friday 08:00–17:00, 60-minute break, 15-minute grace.
INSERT INTO "work_schedule" (id, name, is_default, grace_minutes, break_minutes, break_threshold_minutes, updated_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'Standard (Mon–Fri 8:00–17:00)', true, 15, 60, 240, now());
INSERT INTO "work_schedule_day" (schedule_id, weekday, start_minute, end_minute)
SELECT '00000000-0000-4000-8000-000000000001', d, 480, 1020 FROM generate_series(1, 5) AS d;
