import { Injectable } from '@nestjs/common';
import type { UndertimeTier } from '@cims/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { dateColumn, eachDate, fromDateColumn } from '../attendance/domain/work-date';
import { ScheduleService } from '../attendance/schedule.service';
import { SettingsService } from '../settings/settings.service';
import type { PayDay, PayInput } from './domain/payroll-calculator';

/**
 * Collects everything the payroll calculator needs for one employee and period from attendance,
 * approved leave, overtime decisions and pay setup. Read-only; the calculator does the maths.
 */
@Injectable()
export class PayInputsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedules: ScheduleService,
    private readonly settings: SettingsService,
  ) {}

  async forEmployee(employeeId: string, from: string, to: string): Promise<PayInput> {
    const range = { gte: dateColumn(from), lte: dateColumn(to) };
    const [schedule, holidays, days, leave, overtime, profiles, items, threshold] =
      await Promise.all([
        this.schedules.forEmployee(employeeId),
        this.schedules.holidaysBetween(from, to),
        this.prisma.attendanceDay.findMany({ where: { employeeId, workDate: range } }),
        this.prisma.leaveRequestDay.findMany({
          where: { employeeId, date: range, request: { status: 'APPROVED' } },
          select: { date: true, request: { select: { leaveType: { select: { isPaid: true } } } } },
        }),
        this.prisma.overtimeRecord.findMany({
          where: { employeeId, workDate: range, status: { in: ['APPROVED', 'PENDING'] } },
        }),
        this.prisma.compensationProfile.findMany({
          where: { employeeId, effectiveFrom: { lte: dateColumn(to) } },
          include: { undertimePolicy: true },
        }),
        this.prisma.employeePayItem.findMany({
          where: {
            employeeId,
            effectiveFrom: { lte: dateColumn(to) },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateColumn(from) } }],
            type: { isActive: true },
          },
          include: { type: true },
          orderBy: [{ type: { name: 'asc' } }, { effectiveFrom: 'asc' }],
        }),
        this.settings.get('undertime.thresholdMinutes'),
      ]);

    const attendance = new Map(days.map((d) => [fromDateColumn(d.workDate), d]));
    const leaveByDate = new Map(
      leave.map((l) => [fromDateColumn(l.date), l.request.leaveType.isPaid]),
    );
    const otByDate = new Map(overtime.map((o) => [fromDateColumn(o.workDate), o]));
    const scheduledOn = (date: string) => {
      const w = schedule.windowFor(date);
      return w && !holidays.has(date)
        ? Math.max(0, w.endMinute - w.startMinute - schedule.policy.breakMinutes)
        : 0;
    };

    const payDays: PayDay[] = eachDate(from, to).map((date) => {
      const a = attendance.get(date);
      const ot = otByDate.get(date);
      const overtimeFields = {
        approvedOvertimeMinutes: ot?.status === 'APPROVED' ? (ot.approvedMinutes ?? 0) : 0,
        pendingOvertimeMinutes: ot?.status === 'PENDING' ? ot.actualMinutes : 0,
      };
      if (a)
        return {
          date,
          kind: a.status === 'INCOMPLETE' || a.hasOpenPunch ? 'INCOMPLETE' : 'WORKED',
          scheduledMinutes: a.scheduledMinutes,
          lateMinutes: a.lateMinutes,
          undertimeMinutes: a.undertimeMinutes,
          ...overtimeFields,
        };
      const paidLeave = leaveByDate.get(date);
      return {
        date,
        kind: paidLeave === undefined ? 'NONE' : paidLeave ? 'PAID_LEAVE' : 'UNPAID_LEAVE',
        scheduledMinutes: scheduledOn(date),
        lateMinutes: 0,
        undertimeMinutes: 0,
        ...overtimeFields,
      };
    });

    return {
      from,
      to,
      days: payDays,
      profiles: profiles.map((p) => ({
        id: p.id,
        effectiveFrom: fromDateColumn(p.effectiveFrom),
        hourlyRateCentavos: p.hourlyRateCentavos,
        overtimeRateKind: p.overtimeRateKind,
        overtimeMultiplierPermille: p.overtimeMultiplierPermille,
        overtimeFixedRateCentavos: p.overtimeFixedRateCentavos,
        undertimePolicy: {
          name: p.undertimePolicy.name,
          kind: p.undertimePolicy.kind,
          blockMinutes: p.undertimePolicy.blockMinutes,
          amountPerBlockCentavos: p.undertimePolicy.amountPerBlockCentavos,
          chargePartialBlock: p.undertimePolicy.chargePartialBlock,
          tiers: (p.undertimePolicy.tiers as UndertimeTier[] | null) ?? null,
        },
      })),
      items: items.map((i) => ({
        label: i.type.name,
        direction: i.type.direction,
        calculation: i.calculation,
        amountCentavos: i.amountCentavos,
        rateBasisPoints: i.rateBasisPoints,
      })),
      undertimeThresholdMinutes: threshold,
    };
  }
}
