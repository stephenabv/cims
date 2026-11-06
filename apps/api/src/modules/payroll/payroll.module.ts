import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { CompensationService } from './compensation.service';
import { PayInputsService } from './pay-inputs.service';
import { CompensationController, PayrollSetupController } from './payroll.controller';
import { PayrollConfigService } from './payroll-config.service';

@Module({
  imports: [AttendanceModule],
  controllers: [PayrollSetupController, CompensationController],
  providers: [PayrollConfigService, CompensationService, PayInputsService],
  exports: [PayInputsService],
})
export class PayrollModule {}
