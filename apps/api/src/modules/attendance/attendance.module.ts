import { Module } from '@nestjs/common';
import { AttendanceDayService } from './attendance-day.service';
import { AttendanceQueryService } from './attendance-query.service';
import {
  AttendanceController,
  KioskController,
  KioskDevicesController,
  SchedulesController,
} from './attendance.controller';
import { KioskDeviceService } from './kiosk-device.service';
import { PunchService } from './punch.service';
import { ScheduleService } from './schedule.service';

@Module({
  controllers: [KioskController, KioskDevicesController, AttendanceController, SchedulesController],
  providers: [
    ScheduleService,
    KioskDeviceService,
    PunchService,
    AttendanceDayService,
    AttendanceQueryService,
  ],
  exports: [ScheduleService, AttendanceDayService, AttendanceQueryService],
})
export class AttendanceModule {}
