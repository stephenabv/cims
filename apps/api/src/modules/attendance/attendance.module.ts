import { Module } from '@nestjs/common';
import { OvertimeSyncService } from '../overtime/overtime-sync.service';
import { AttendanceDayService } from './attendance-day.service';
import { AttendanceQueryService } from './attendance-query.service';
import {
  AttendanceController,
  KioskController,
  KioskDevicesController,
  SchedulesController,
} from './attendance.controller';
import { KioskDeviceService } from './kiosk-device.service';
import { AttendanceAdjustmentService } from './attendance-adjustment.service';
import { AttendanceConflictService } from './attendance-conflict.service';
import { KioskIdentityService } from './kiosk-identity.service';
import { KioskSyncKeyService } from './kiosk-sync-key.service';
import { KioskSyncService } from './kiosk-sync.service';
import { PunchService } from './punch.service';
import { ScheduleService } from './schedule.service';

@Module({
  controllers: [KioskController, KioskDevicesController, AttendanceController, SchedulesController],
  providers: [
    ScheduleService,
    KioskDeviceService,
    PunchService,
    KioskIdentityService,
    KioskSyncKeyService,
    KioskSyncService,
    AttendanceConflictService,
    AttendanceAdjustmentService,
    AttendanceDayService,
    AttendanceQueryService,
    OvertimeSyncService,
  ],
  exports: [ScheduleService, AttendanceDayService, AttendanceQueryService],
})
export class AttendanceModule {}
