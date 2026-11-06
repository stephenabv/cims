-- CreateEnum
CREATE TYPE "attendance_conflict_status" AS ENUM ('OPEN', 'ACCEPTED', 'REJECTED');

-- CreateTable
CREATE TABLE "kiosk_sync_key" (
    "id" UUID NOT NULL,
    "public_key_spki" TEXT NOT NULL,
    "private_key_enc" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(3),

    CONSTRAINT "kiosk_sync_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_batch" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "item_count" INTEGER NOT NULL,
    "applied" INTEGER NOT NULL,
    "duplicates" INTEGER NOT NULL,
    "conflicts" INTEGER NOT NULL,
    "rejected" INTEGER NOT NULL,
    "deferred" INTEGER NOT NULL,

    CONSTRAINT "sync_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_conflict" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "reason" VARCHAR(40) NOT NULL,
    "status" "attendance_conflict_status" NOT NULL DEFAULT 'OPEN',
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution_note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_conflict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_batch_device_id_received_at_idx" ON "sync_batch"("device_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_conflict_event_id_key" ON "attendance_conflict"("event_id");

-- CreateIndex
CREATE INDEX "attendance_conflict_status_created_at_idx" ON "attendance_conflict"("status", "created_at");

-- AddForeignKey
ALTER TABLE "sync_batch" ADD CONSTRAINT "sync_batch_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "kiosk_device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_conflict" ADD CONSTRAINT "attendance_conflict_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "attendance_event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_conflict" ADD CONSTRAINT "attendance_conflict_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraints ----------------------------------------------------

-- At most one active kiosk sync key.
CREATE UNIQUE INDEX "kiosk_sync_key_single_active" ON "kiosk_sync_key" ("is_active") WHERE "is_active";

ALTER TABLE "sync_batch" ADD CONSTRAINT "sync_batch_counts_check"
  CHECK (item_count >= 0 AND applied >= 0 AND duplicates >= 0 AND conflicts >= 0 AND rejected >= 0 AND deferred >= 0
         AND applied + duplicates + conflicts + rejected + deferred = item_count);

ALTER TABLE "attendance_conflict" ADD CONSTRAINT "attendance_conflict_resolution_check"
  CHECK ((status = 'OPEN') = (resolved_at IS NULL));

-- Conflicts are an audit trail of offline data: never deleted.
CREATE FUNCTION protect_attendance_conflict() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'attendance_conflict rows cannot be deleted' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER attendance_conflict_protect BEFORE DELETE ON "attendance_conflict"
  FOR EACH ROW EXECUTE FUNCTION protect_attendance_conflict();
