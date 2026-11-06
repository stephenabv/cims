import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { LeaveConfigService } from './leave-config.service';
import { LeaveConfigController, LeaveController } from './leave.controller';
import { LeaveRequestService } from './leave-request.service';

@Module({
  imports: [AttendanceModule],
  controllers: [LeaveController, LeaveConfigController],
  providers: [LeaveConfigService, LeaveRequestService],
})
export class LeaveModule {}
