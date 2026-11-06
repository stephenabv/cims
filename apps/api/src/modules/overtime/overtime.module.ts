import { Module } from '@nestjs/common';
import { OvertimeController } from './overtime.controller';
import { OvertimeService } from './overtime.service';

/** Record syncing lives in AttendanceModule (OvertimeSyncService); this module reads and decides. */
@Module({
  controllers: [OvertimeController],
  providers: [OvertimeService],
})
export class OvertimeModule {}
