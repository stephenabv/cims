import { Injectable } from '@nestjs/common';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import {
  type KioskAction,
  type KioskActionPolicy,
  type TimelinePunch,
  candidateWorkDates,
  decideKioskAction,
} from './domain/kiosk-action';
import { addDays, dateColumn, fromDateColumn, workDateOf } from './domain/work-date';
import { ScheduleService } from './schedule.service';

export interface KioskActionContext {
  timezone: string;
  policy: KioskActionPolicy;
}

/**
 * Loads the facts the unified kiosk button needs and asks the domain rule what to do
 * (see `domain/kiosk-action.ts`). Shared by online punches and offline sync so both decide alike.
 */
@Injectable()
export class KioskActionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly schedules: ScheduleService,
  ) {}

  async context(): Promise<KioskActionContext> {
    const s = await this.settings.getMany([
      'company.timezone',
      'attendance.duplicateWindowSeconds',
      'attendance.maxShiftHours',
      'attendance.shiftMarginMinutes',
    ] as const);
    return {
      timezone: s['company.timezone'],
      policy: {
        duplicateWindowMs: s['attendance.duplicateWindowSeconds'] * 1000,
        maxShiftMs: s['attendance.maxShiftHours'] * 3_600_000,
        shiftMarginMs: s['attendance.shiftMarginMinutes'] * 60_000,
      },
    };
  }

  /**
   * What a kiosk press by `employeeId` at `at` means, considering only accepted punches at or
   * before `at`. Callers that act on the answer must hold the employee row lock in `tx`.
   */
  async decide(
    tx: PrismaTx,
    employeeId: string,
    at: Date,
    ctx: KioskActionContext,
  ): Promise<KioskAction> {
    const calendarDate = workDateOf(at, ctx.timezone);
    const dates = candidateWorkDates(calendarDate);
    const [lastRow, nearby, schedule] = await Promise.all([
      tx.attendanceEvent.findFirst({
        where: { employeeId, status: 'ACCEPTED', occurredAt: { lte: at } },
        orderBy: { occurredAt: 'desc' },
        select: { type: true, occurredAt: true, workDate: true },
      }),
      tx.attendanceEvent.findMany({
        where: {
          employeeId,
          status: 'ACCEPTED',
          occurredAt: { lte: at },
          // The last punch's own date is included so a recent time-out can be checked.
          workDate: { gte: dateColumn(addDays(dates[0]!, -1)), lte: dateColumn(dates[2]!) },
        },
        orderBy: { occurredAt: 'asc' },
        select: { type: true, occurredAt: true, workDate: true },
      }),
      this.schedules.forEmployee(employeeId, tx),
    ]);
    const toPunch = (r: { type: TimelinePunch['type']; occurredAt: Date; workDate: Date }) => ({
      type: r.type,
      at: r.occurredAt,
      workDate: fromDateColumn(r.workDate),
    });
    const byDate = new Map<string, TimelinePunch[]>();
    for (const r of nearby) {
      const p = toPunch(r);
      byDate.set(p.workDate, [...(byDate.get(p.workDate) ?? []), p]);
    }
    return decideKioskAction(
      {
        now: at,
        timezone: ctx.timezone,
        last: lastRow ? toPunch(lastRow) : null,
        windowFor: (d) => schedule.windowFor(d),
        punchesOn: (d) => byDate.get(d) ?? [],
        policy: ctx.policy,
      },
      calendarDate,
    );
  }
}
