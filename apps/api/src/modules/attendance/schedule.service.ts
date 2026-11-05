import { Injectable } from '@nestjs/common';
import type { HolidayInput, ScheduleInput } from '@cims/shared';
import type { WorkSchedule, WorkScheduleDay } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import type { AuthContext, ClientInfo } from '../../common/http/request-context';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { SchedulePolicy, ScheduleWindow } from './domain/attendance-calculator';
import { dateColumn, fromDateColumn, isoWeekday } from './domain/work-date';

export type ScheduleWithDays = WorkSchedule & { days: WorkScheduleDay[] };

export interface ResolvedSchedule {
  policy: SchedulePolicy;
  windowFor(workDate: string): ScheduleWindow | null;
}

export function toResolved(s: ScheduleWithDays): ResolvedSchedule {
  const byDay = new Map(
    s.days.map((d) => [d.weekday, { startMinute: d.startMinute, endMinute: d.endMinute }]),
  );
  return {
    policy: {
      graceMinutes: s.graceMinutes,
      breakMinutes: s.breakMinutes,
      breakThresholdMinutes: s.breakThresholdMinutes,
    },
    windowFor: (workDate) => byDay.get(isoWeekday(workDate)) ?? null,
  };
}

@Injectable()
export class ScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async defaultSchedule(tx: PrismaTx = this.prisma): Promise<ScheduleWithDays> {
    const s = await tx.workSchedule.findFirst({
      where: { isDefault: true },
      include: { days: true },
    });
    if (!s) throw new Error('No default work schedule configured');
    return s;
  }

  /** The employee's own schedule, falling back to the company default. */
  async forEmployee(employeeId: string, tx: PrismaTx = this.prisma): Promise<ResolvedSchedule> {
    const e = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { workSchedule: { include: { days: true } } },
    });
    return toResolved(e?.workSchedule?.isActive ? e.workSchedule : await this.defaultSchedule(tx));
  }

  /** Schedules for many employees at once (monitoring screens). */
  async forEmployees(employeeIds: string[]): Promise<Map<string, ResolvedSchedule>> {
    const rows = await this.prisma.employee.findMany({
      where: { id: { in: employeeIds } },
      select: { id: true, workSchedule: { include: { days: true } } },
    });
    const fallback = toResolved(await this.defaultSchedule());
    return new Map(
      rows.map((r) => [r.id, r.workSchedule?.isActive ? toResolved(r.workSchedule) : fallback]),
    );
  }

  async holidaysBetween(
    from: string,
    to: string,
    tx: PrismaTx = this.prisma,
  ): Promise<Set<string>> {
    const rows = await tx.holiday.findMany({
      where: { date: { gte: dateColumn(from), lte: dateColumn(to) } },
      select: { date: true },
    });
    return new Set(rows.map((r) => fromDateColumn(r.date)));
  }

  list() {
    return this.prisma.workSchedule.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: { days: { orderBy: { weekday: 'asc' } }, _count: { select: { employees: true } } },
    });
  }

  async create(actor: AuthContext, input: ScheduleInput, client: ClientInfo) {
    return this.prisma.$transaction(async (tx) => {
      const s = await tx.workSchedule.create({
        data: {
          name: input.name,
          graceMinutes: input.graceMinutes,
          breakMinutes: input.breakMinutes,
          breakThresholdMinutes: input.breakThresholdMinutes,
          days: { create: input.days },
        },
        include: { days: true },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'schedule.create',
          entityType: 'work_schedule',
          entityId: s.id,
          after: input,
          client,
        },
        tx,
      );
      return s;
    });
  }

  /** Changes apply to attendance recomputed afterwards; already-computed days keep their figures. */
  async update(actor: AuthContext, id: string, input: ScheduleInput, client: ClientInfo) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.workSchedule.findUnique({ where: { id }, include: { days: true } });
      if (!before) throw new NotFoundError('Schedule');
      await tx.workScheduleDay.deleteMany({ where: { scheduleId: id } });
      const s = await tx.workSchedule.update({
        where: { id },
        data: {
          name: input.name,
          graceMinutes: input.graceMinutes,
          breakMinutes: input.breakMinutes,
          breakThresholdMinutes: input.breakThresholdMinutes,
          days: { create: input.days },
        },
        include: { days: true },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'schedule.update',
          entityType: 'work_schedule',
          entityId: id,
          before,
          after: input,
          client,
        },
        tx,
      );
      return s;
    });
  }

  async assign(
    actor: AuthContext,
    employeeId: string,
    scheduleId: string | null,
    client: ClientInfo,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (
        scheduleId &&
        !(await tx.workSchedule.findFirst({ where: { id: scheduleId, isActive: true } }))
      )
        throw new NotFoundError('Schedule');
      const emp = await tx.employee.findUnique({
        where: { id: employeeId },
        select: { workScheduleId: true },
      });
      if (!emp) throw new NotFoundError('Employee');
      await tx.employee.update({
        where: { id: employeeId },
        data: { workScheduleId: scheduleId, version: { increment: 1 } },
      });
      await tx.employeeChangeHistory.create({
        data: {
          employeeId,
          field: 'workSchedule',
          oldValue: emp.workScheduleId,
          newValue: scheduleId,
          changedById: actor.userId,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'schedule.assign',
          entityType: 'employee',
          entityId: employeeId,
          before: { scheduleId: emp.workScheduleId },
          after: { scheduleId },
          client,
        },
        tx,
      );
    });
  }

  listHolidays(year: number) {
    return this.prisma.holiday.findMany({
      where: { date: { gte: dateColumn(`${year}-01-01`), lte: dateColumn(`${year}-12-31`) } },
      orderBy: { date: 'asc' },
    });
  }

  async addHoliday(actor: AuthContext, input: HolidayInput, client: ClientInfo) {
    return this.prisma.$transaction(async (tx) => {
      if (await tx.holiday.findUnique({ where: { date: dateColumn(input.date) } }))
        throw new ConflictError('A holiday already exists on that date');
      const h = await tx.holiday.create({
        data: { date: dateColumn(input.date), name: input.name },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'holiday.create',
          entityType: 'holiday',
          entityId: h.id,
          after: input,
          client,
        },
        tx,
      );
      return h;
    });
  }

  async removeHoliday(actor: AuthContext, id: string, client: ClientInfo): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const h = await tx.holiday.findUnique({ where: { id } });
      if (!h) throw new NotFoundError('Holiday');
      await tx.holiday.delete({ where: { id } });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'holiday.delete',
          entityType: 'holiday',
          entityId: id,
          before: h,
          client,
        },
        tx,
      );
    });
  }
}
