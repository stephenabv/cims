import { Injectable } from '@nestjs/common';
import {
  type AttendanceDayView,
  type AttendanceMonitorQuery,
  type AttendanceMonitorResult,
  type AttendanceMonitorRow,
  type AttendanceRangeResult,
  type AttendanceSummary,
  type DailyStatus,
  PERMISSIONS,
} from '@cims/shared';
import type { AttendanceDay, AttendanceEvent, Prisma } from '@prisma/client';
import { ForbiddenError, NotFoundError } from '../../common/errors/app-error';
import type { AuthContext } from '../../common/http/request-context';
import { Clock } from '../../infrastructure/clock/clock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { dateColumn, eachDate, fromDateColumn, workDateOf } from './domain/work-date';
import { type ResolvedSchedule, ScheduleService } from './schedule.service';

type Scope = { kind: 'all' } | { kind: 'departments'; ids: string[] };

/** Status for a date with no punches, derived from schedule, holidays and hire date. */
export function statusWithoutPunches(
  workDate: string,
  today: string,
  dateHired: string,
  scheduled: boolean,
  isHoliday: boolean,
): DailyStatus {
  if (workDate < dateHired) return 'NOT_EMPLOYED';
  if (isHoliday) return 'HOLIDAY';
  if (!scheduled) return 'REST_DAY';
  return workDate < today ? 'ABSENT' : 'NOT_YET_IN';
}

/**
 * Status shown for a day that has punches. A time-in still open on the current work date is a
 * shift in progress, not an incomplete record, so it is shown by arrival (present or late) instead.
 */
export function statusWithPunches(
  record: Pick<AttendanceDay, 'status' | 'hasOpenPunch' | 'lateMinutes'>,
  workDate: string,
  today: string,
  scheduled: boolean,
  isHoliday: boolean,
): DailyStatus {
  if (record.status !== 'INCOMPLETE' || !record.hasOpenPunch || workDate !== today)
    return record.status;
  if (isHoliday) return 'HOLIDAY_WORKED';
  if (!scheduled) return 'REST_DAY_WORKED';
  return record.lateMinutes > 0 ? 'LATE' : 'PRESENT';
}

export function summarise(days: AttendanceDayView[]): AttendanceSummary {
  const s: AttendanceSummary = {
    daysWorked: 0,
    totalWorkedMinutes: 0,
    totalLateMinutes: 0,
    lateCount: 0,
    totalUndertimeMinutes: 0,
    totalOvertimeMinutes: 0,
    absences: 0,
    incomplete: 0,
  };
  for (const d of days) {
    if (d.workedMinutes > 0) s.daysWorked += 1;
    s.totalWorkedMinutes += d.workedMinutes;
    s.totalLateMinutes += d.lateMinutes;
    if (d.lateMinutes > 0) s.lateCount += 1;
    s.totalUndertimeMinutes += d.undertimeMinutes;
    s.totalOvertimeMinutes += d.overtimeMinutes;
    if (d.status === 'ABSENT') s.absences += 1;
    if (d.status === 'INCOMPLETE') s.incomplete += 1;
  }
  return s;
}

@Injectable()
export class AttendanceQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedules: ScheduleService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  /** Day-by-day attendance for one employee. Caller must have authorised access to `employeeId`. */
  async range(employeeId: string, from: string, to: string): Promise<AttendanceRangeResult> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, accountNumber: true, firstName: true, lastName: true, dateHired: true },
    });
    if (!employee) throw new NotFoundError('Employee');
    const timezone = await this.settings.get('company.timezone');
    const today = workDateOf(this.clock.now(), timezone);
    const end = to > today ? today : to;
    const dates = from <= end ? eachDate(from, end) : [];

    const [records, events, schedule, holidays] = await Promise.all([
      this.prisma.attendanceDay.findMany({
        where: { employeeId, workDate: { gte: dateColumn(from), lte: dateColumn(end) } },
      }),
      this.prisma.attendanceEvent.findMany({
        where: { employeeId, workDate: { gte: dateColumn(from), lte: dateColumn(end) } },
        orderBy: { occurredAt: 'asc' },
      }),
      this.schedules.forEmployee(employeeId),
      this.schedules.holidaysBetween(from, end),
    ]);
    const byDate = new Map(records.map((r) => [fromDateColumn(r.workDate), r]));
    const eventsByDate = new Map<string, AttendanceEvent[]>();
    for (const e of events) {
      const k = fromDateColumn(e.workDate);
      eventsByDate.set(k, [...(eventsByDate.get(k) ?? []), e]);
    }
    const hired = fromDateColumn(employee.dateHired);

    const days = dates
      .map((d) =>
        this.dayView(
          d,
          byDate.get(d),
          eventsByDate.get(d) ?? [],
          schedule,
          holidays.has(d),
          today,
          hired,
        ),
      )
      .filter((d) => d.status !== 'NOT_EMPLOYED')
      .reverse();

    return {
      employee: {
        id: employee.id,
        accountNumber: employee.accountNumber,
        fullName: `${employee.firstName} ${employee.lastName}`,
      },
      timezone,
      days,
      summary: summarise(days),
    };
  }

  async assertCanViewEmployee(actor: AuthContext, employeeId: string): Promise<void> {
    if (employeeId === actor.employeeId) return;
    const scope = await this.scope(actor);
    const e = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { departmentId: true },
    });
    if (
      !e ||
      (scope.kind === 'departments' && (!e.departmentId || !scope.ids.includes(e.departmentId)))
    )
      throw new NotFoundError('Employee');
  }

  /**
   * Daily monitoring board for HR/executives (§3.1, §3.8). Status is computed for every in-scope
   * employee with an active account, so absentees appear even though they have no punches.
   * Paginates in memory after filtering; adequate for a single company of a few thousand staff.
   */
  async monitor(actor: AuthContext, q: AttendanceMonitorQuery): Promise<AttendanceMonitorResult> {
    const scope = await this.scope(actor);
    const timezone = await this.settings.get('company.timezone');
    const today = workDateOf(this.clock.now(), timezone);
    const and: Prisma.EmployeeWhereInput[] = [
      { account: { status: 'ACTIVE' } },
      { dateHired: { lte: dateColumn(q.date) } },
    ];
    if (scope.kind === 'departments') and.push({ departmentId: { in: scope.ids } });
    if (q.departmentId) and.push({ departmentId: q.departmentId });
    if (q.search) {
      and.push({
        OR: [
          { firstName: { contains: q.search, mode: 'insensitive' } },
          { lastName: { contains: q.search, mode: 'insensitive' } },
          { accountNumber: { contains: q.search, mode: 'insensitive' } },
        ],
      });
    }
    const employees = await this.prisma.employee.findMany({
      where: { AND: and },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: {
        id: true,
        accountNumber: true,
        firstName: true,
        lastName: true,
        dateHired: true,
        department: { select: { name: true } },
      },
    });
    const ids = employees.map((e) => e.id);
    const [records, schedules, holidays] = await Promise.all([
      this.prisma.attendanceDay.findMany({
        where: { employeeId: { in: ids }, workDate: dateColumn(q.date) },
      }),
      this.schedules.forEmployees(ids),
      this.schedules.holidaysBetween(q.date, q.date),
    ]);
    const byEmployee = new Map(records.map((r) => [r.employeeId, r]));
    const isHoliday = holidays.has(q.date);

    const rows: AttendanceMonitorRow[] = employees.map((e) => {
      const r = byEmployee.get(e.id);
      const schedule = schedules.get(e.id)!;
      const scheduled = schedule.windowFor(q.date) !== null;
      const status: DailyStatus = r
        ? statusWithPunches(r, q.date, today, scheduled, isHoliday)
        : statusWithoutPunches(q.date, today, fromDateColumn(e.dateHired), scheduled, isHoliday);
      return {
        employee: {
          id: e.id,
          accountNumber: e.accountNumber,
          fullName: `${e.firstName} ${e.lastName}`,
          department: e.department?.name ?? null,
        },
        status,
        firstIn: r?.firstIn?.toISOString() ?? null,
        lastOut: r?.lastOut?.toISOString() ?? null,
        workedMinutes: r?.workedMinutes ?? 0,
        lateMinutes: r?.lateMinutes ?? 0,
      };
    });
    const counts: Partial<Record<DailyStatus, number>> = {};
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const filtered = q.status ? rows.filter((r) => r.status === q.status) : rows;
    const start = (q.page - 1) * q.pageSize;
    return {
      date: q.date,
      timezone,
      counts,
      rows: filtered.slice(start, start + q.pageSize),
      meta: { page: q.page, pageSize: q.pageSize, total: filtered.length },
    };
  }

  private async scope(actor: AuthContext): Promise<Scope> {
    if (actor.permissions.has(PERMISSIONS.ATTENDANCE_VIEW_ALL)) return { kind: 'all' };
    if (actor.permissions.has(PERMISSIONS.ATTENDANCE_VIEW_DEPARTMENT)) {
      const ds = await this.prisma.department.findMany({
        where: { headId: actor.employeeId },
        select: { id: true },
      });
      return { kind: 'departments', ids: ds.map((d) => d.id) };
    }
    throw new ForbiddenError();
  }

  private dayView(
    date: string,
    record: AttendanceDay | undefined,
    events: AttendanceEvent[],
    schedule: ResolvedSchedule,
    isHoliday: boolean,
    today: string,
    hired: string,
  ): AttendanceDayView {
    const punches = events.map((e) => ({
      id: e.id,
      type: e.type,
      occurredAt: e.occurredAt.toISOString(),
      source: e.source,
      status: e.status,
    }));
    const window = schedule.windowFor(date);
    if (record) {
      return {
        workDate: date,
        status: statusWithPunches(record, date, today, window !== null, isHoliday),
        firstIn: record.firstIn?.toISOString() ?? null,
        lastOut: record.lastOut?.toISOString() ?? null,
        workedMinutes: record.workedMinutes,
        regularMinutes: record.regularMinutes,
        lateMinutes: record.lateMinutes,
        undertimeMinutes: record.undertimeMinutes,
        overtimeMinutes: record.overtimeMinutes,
        scheduledMinutes: record.scheduledMinutes,
        punches,
      };
    }
    return {
      workDate: date,
      status: statusWithoutPunches(date, today, hired, window !== null, isHoliday),
      firstIn: null,
      lastOut: null,
      workedMinutes: 0,
      regularMinutes: 0,
      lateMinutes: 0,
      undertimeMinutes: 0,
      overtimeMinutes: 0,
      scheduledMinutes:
        window && !isHoliday
          ? Math.max(0, window.endMinute - window.startMinute - schedule.policy.breakMinutes)
          : 0,
      punches,
    };
  }
}
