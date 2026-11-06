import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES, type KioskPunchInput, type KioskPunchResult } from '@cims/shared';
import { DateTime } from 'luxon';
import {
  AppError,
  ConflictError,
  LockedError,
  UnauthenticatedError,
} from '../../common/errors/app-error';
import type { ClientInfo } from '../../common/http/request-context';
import { Clock } from '../../infrastructure/clock/clock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { AttendanceDayService } from './attendance-day.service';
import { fromDateColumn, workDateOf } from './domain/work-date';
import { KioskIdentityService } from './kiosk-identity.service';

const INVALID = 'Invalid account number or PIN';

export type PunchRejection = 'ALREADY_TIMED_IN' | 'DUPLICATE' | 'NOT_TIMED_IN' | 'SHIFT_TOO_LONG';

/**
 * Online kiosk time-in/time-out (spec §3.1). Credential A only: account number + PIN, no session.
 * Concurrency: the employee row is locked for the duration of the decision, so two simultaneous
 * punches by the same person are serialised and cannot both succeed.
 */
@Injectable()
export class PunchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: KioskIdentityService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly days: AttendanceDayService,
    private readonly clock: Clock,
  ) {}

  async punch(
    input: KioskPunchInput,
    deviceId: string | null,
    client: ClientInfo,
  ): Promise<KioskPunchResult> {
    const now = this.clock.now();
    const verified = await this.identity.verify(input.accountNumber, input.pin, now, client);
    if (!verified.ok) {
      if (verified.reason === 'LOCKED')
        throw new LockedError(
          'Too many wrong PIN attempts. Try again later or ask HR to reset your PIN.',
          verified.lockedUntil,
        );
      if (verified.reason === 'INACTIVE')
        throw new AppError(
          ERROR_CODES.ACCOUNT_INACTIVE,
          'This account cannot record attendance. Please contact HR.',
          HttpStatus.FORBIDDEN,
        );
      throw new UnauthenticatedError(ERROR_CODES.INVALID_CREDENTIALS, INVALID);
    }
    const { identity } = verified;
    const s = await this.settings.getMany([
      'company.timezone',
      'attendance.duplicateWindowSeconds',
      'attendance.maxShiftHours',
    ] as const);

    const tz = s['company.timezone'];
    const dupMs = s['attendance.duplicateWindowSeconds'] * 1000;
    const maxShiftMs = s['attendance.maxShiftHours'] * 3_600_000;
    const employeeId = identity.employeeId;
    const clockTime = (d: Date) => DateTime.fromJSDate(d, { zone: tz }).toFormat('h:mm a');
    const reject = (reason: PunchRejection, message: string) =>
      new ConflictError(message, { reason });

    const event = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM employee WHERE id = ${employeeId}::uuid FOR UPDATE`;
      const last = await tx.attendanceEvent.findFirst({
        where: { employeeId, status: 'ACCEPTED' },
        orderBy: { occurredAt: 'desc' },
      });
      const sinceLast = last ? now.getTime() - last.occurredAt.getTime() : Infinity;
      const openIn = last?.type === 'TIME_IN' && sinceLast < maxShiftMs ? last : null;

      let workDate: string;
      if (input.type === 'TIME_IN') {
        if (openIn) {
          throw sinceLast < dupMs
            ? reject(
                'DUPLICATE',
                `Already recorded: you timed in at ${clockTime(openIn.occurredAt)}.`,
              )
            : reject(
                'ALREADY_TIMED_IN',
                `You are already timed in since ${clockTime(openIn.occurredAt)}. Time out first.`,
              );
        }
        workDate = workDateOf(now, tz);
      } else {
        if (!openIn) {
          if (last?.type === 'TIME_OUT' && sinceLast < dupMs)
            throw reject(
              'DUPLICATE',
              `Already recorded: you timed out at ${clockTime(last.occurredAt)}.`,
            );
          if (last?.type === 'TIME_IN')
            throw reject(
              'SHIFT_TOO_LONG',
              `Your last time-in (${clockTime(last.occurredAt)}) was too long ago. Ask HR to correct your record.`,
            );
          throw reject('NOT_TIMED_IN', 'There is no time-in to close. Time in first.');
        }
        workDate = fromDateColumn(openIn.workDate);
      }

      const created = await tx.attendanceEvent.create({
        data: {
          employeeId,
          type: input.type,
          occurredAt: now,
          recordedAt: now,
          workDate: new Date(`${workDate}T00:00:00Z`),
          source: 'KIOSK_ONLINE',
          deviceId,
        },
      });
      await this.days.recompute(tx, employeeId, workDate);
      await this.audit.authEvent(
        {
          type: 'PIN_VERIFY',
          success: true,
          userId: identity.userId,
          accountNumber: input.accountNumber,
          reason: input.type.toLowerCase(),
          client,
        },
        tx,
      );
      return { created, workDate };
    });

    return {
      type: event.created.type,
      occurredAt: event.created.occurredAt.toISOString(),
      workDate: event.workDate,
      displayName: `${identity.firstName} ${identity.lastName.charAt(0)}.`,
    };
  }
}
