import { Injectable } from '@nestjs/common';
import type { PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { dateColumn } from '../attendance/domain/work-date';
import { reconcileOvertime } from './domain/overtime-reconcile';

/**
 * Applies {@link reconcileOvertime} inside the transaction that recomputed an attendance day.
 *
 * Provided by AttendanceModule (the attendance writers call it), so the overtime module can depend
 * on attendance without a cycle. Callers already hold the employee row lock; the record row is
 * locked as well so a decision cannot interleave with the change.
 */
@Injectable()
export class OvertimeSyncService {
  constructor(private readonly settings: SettingsService) {}

  /** `overtimeMinutes` is null when the day has no completed attendance. */
  async sync(
    tx: PrismaTx,
    employeeId: string,
    workDate: string,
    overtimeMinutes: number | null,
  ): Promise<void> {
    const date = dateColumn(workDate);
    await tx.$queryRaw`SELECT id FROM overtime_record
      WHERE employee_id = ${employeeId}::uuid AND work_date = ${date}::date FOR UPDATE`;
    const record = await tx.overtimeRecord.findUnique({
      where: { employeeId_workDate: { employeeId, workDate: date } },
      include: { _count: { select: { history: true } } },
    });
    const minimum = await this.settings.get('overtime.minimumMinutes', tx);
    const change = reconcileOvertime(
      record && {
        status: record.status,
        actualMinutes: record.actualMinutes,
        hasHistory: record._count.history > 0,
      },
      overtimeMinutes,
      minimum,
    );

    switch (change.kind) {
      case 'none':
        return;
      case 'create':
        await tx.overtimeRecord.create({
          data: { employeeId, workDate: date, actualMinutes: change.actualMinutes },
        });
        return;
      case 'update':
        await tx.overtimeRecord.update({
          where: { id: record!.id },
          data: { actualMinutes: change.actualMinutes, version: { increment: 1 } },
        });
        return;
      case 'delete':
        await tx.overtimeRecord.delete({ where: { id: record!.id } });
        return;
      case 'reopen':
      case 'void': {
        const reopen = change.kind === 'reopen';
        await tx.overtimeRecord.update({
          where: { id: record!.id },
          data: {
            status: reopen ? 'PENDING' : 'VOIDED',
            approvedMinutes: null,
            ...(reopen ? { actualMinutes: change.actualMinutes } : {}),
            version: { increment: 1 },
          },
        });
        await tx.overtimeHistory.create({
          data: {
            recordId: record!.id,
            action: reopen ? 'REOPEN' : 'VOID',
            minutes: reopen ? change.actualMinutes : null,
            note: reopen
              ? `Attendance changed: overtime was ${change.previousMinutes} min`
              : 'Attendance changed: no overtime left on this day',
          },
        });
        return;
      }
    }
  }
}
