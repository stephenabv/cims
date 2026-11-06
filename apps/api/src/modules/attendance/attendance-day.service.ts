import { Injectable } from '@nestjs/common';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { computeAttendanceDay } from './domain/attendance-calculator';
import { dateColumn } from './domain/work-date';
import { OvertimeSyncService } from '../overtime/overtime-sync.service';
import { ScheduleService } from './schedule.service';

/**
 * Keeps `attendance_day` (and the day's overtime record) consistent with the accepted punches of a
 * work date. Callers hold the employee row lock.
 */
@Injectable()
export class AttendanceDayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedules: ScheduleService,
    private readonly settings: SettingsService,
    private readonly overtime: OvertimeSyncService,
  ) {}

  async recompute(tx: PrismaTx, employeeId: string, workDate: string): Promise<void> {
    const date = dateColumn(workDate);
    const events = await tx.attendanceEvent.findMany({
      where: { employeeId, workDate: date, status: 'ACCEPTED' },
      orderBy: { occurredAt: 'asc' },
    });
    if (events.length === 0) {
      await tx.attendanceDay.deleteMany({ where: { employeeId, workDate: date } });
      await this.overtime.sync(tx, employeeId, workDate, null);
      return;
    }
    const [timezone, schedule, holidays] = await Promise.all([
      this.settings.get('company.timezone', tx),
      this.schedules.forEmployee(employeeId, tx),
      this.schedules.holidaysBetween(workDate, workDate, tx),
    ]);
    const r = computeAttendanceDay(
      events.map((e) => ({ type: e.type, at: e.occurredAt })),
      {
        workDate,
        timezone,
        window: schedule.windowFor(workDate),
        policy: schedule.policy,
        isHoliday: holidays.has(workDate),
      },
    );
    const data = {
      firstIn: r.firstIn,
      lastOut: r.lastOut,
      workedMinutes: r.workedMinutes,
      regularMinutes: r.regularMinutes,
      lateMinutes: r.lateMinutes,
      undertimeMinutes: r.undertimeMinutes,
      overtimeMinutes: r.overtimeMinutes,
      scheduledMinutes: r.scheduledMinutes,
      status: r.status,
      hasOpenPunch: r.hasOpenPunch,
      computedAt: new Date(),
    };
    await tx.attendanceDay.upsert({
      where: { employeeId_workDate: { employeeId, workDate: date } },
      create: { employeeId, workDate: date, ...data },
      update: data,
    });
    const complete = r.status !== 'INCOMPLETE' && !r.hasOpenPunch;
    await this.overtime.sync(tx, employeeId, workDate, complete ? r.overtimeMinutes : null);
  }
}
