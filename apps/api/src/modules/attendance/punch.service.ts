import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type KioskIdentifyInput,
  type KioskIdentifyResult,
  type KioskPunchInput,
  type KioskPunchResult,
  type PunchType,
} from '@cims/shared';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import {
  AppError,
  ConflictError,
  LockedError,
  UnauthenticatedError,
} from '../../common/errors/app-error';
import type { ClientInfo } from '../../common/http/request-context';
import { Clock } from '../../infrastructure/clock/clock';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AttendanceDayService } from './attendance-day.service';
import type { KioskAction } from './domain/kiosk-action';
import { dateColumn } from './domain/work-date';
import { type KioskActionContext, KioskActionService } from './kiosk-action.service';
import { type ConfirmationClaims, KioskConfirmationService } from './kiosk-confirmation.service';
import { type KioskIdentity, KioskIdentityService } from './kiosk-identity.service';

const INVALID = 'Invalid employee number or PIN';

export type PunchRejection =
  | 'ALREADY_TIMED_IN'
  | 'DUPLICATE'
  | 'NOT_TIMED_IN'
  | 'SHIFT_TOO_LONG'
  | 'ALREADY_COMPLETED'
  | 'STATE_CHANGED'
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_INVALID';

const displayName = (e: { firstName: string; lastName: string }) =>
  `${e.firstName} ${e.lastName.charAt(0)}.`;

/**
 * Online kiosk attendance (spec §3.1; attendance spec §1). Credential A only: employee number +
 * PIN, no session. The server, never the kiosk, decides whether a press is a time in or a time
 * out (see `domain/kiosk-action.ts`), and every punch carries the server's clock.
 *
 * Unified flow: `identify` checks the PIN and returns the action on offer with a short-lived
 * confirmation token; `confirm` records it. `punch` does both in one call for older kiosks.
 *
 * Concurrency: recording locks the employee row and re-decides under the lock, so simultaneous
 * presses (two kiosks, double clicks) are serialised and cannot record the same action twice.
 * A confirmation token's nonce is stored as the punch's unique client UUID, so a retried confirm
 * (network drop after the server committed) returns the original punch instead of a new one.
 */
@Injectable()
export class PunchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: KioskIdentityService,
    private readonly actions: KioskActionService,
    private readonly confirmations: KioskConfirmationService,
    private readonly audit: AuditService,
    private readonly days: AttendanceDayService,
    private readonly clock: Clock,
  ) {}

  async identify(
    input: KioskIdentifyInput,
    deviceId: string | null,
    client: ClientInfo,
  ): Promise<KioskIdentifyResult> {
    const now = this.clock.now();
    const who = await this.verify(input.accountNumber, input.pin, now, client);
    const ctx = await this.actions.context();
    const action = await this.actions.decide(this.prisma, who.employeeId, now, ctx);
    const name = displayName(who);
    switch (action.kind) {
      case 'COMPLETED':
        return {
          status: 'COMPLETED',
          displayName: name,
          workDate: action.workDate,
          timeInAt: action.timeInAt.toISOString(),
          timeOutAt: action.timeOutAt.toISOString(),
        };
      case 'JUST_RECORDED':
        return {
          status: 'JUST_RECORDED',
          displayName: name,
          workDate: action.workDate,
          type: action.type,
          occurredAt: action.at.toISOString(),
        };
      default: {
        const { token, expiresAt } = this.confirmations.issue(
          {
            employeeId: who.employeeId,
            userId: who.userId,
            deviceId,
            action: action.kind,
            workDate: action.workDate,
          },
          now,
        );
        return {
          status: 'READY',
          displayName: name,
          action: action.kind,
          workDate: action.workDate,
          timeInAt: action.kind === 'TIME_OUT' ? action.timeInAt.toISOString() : null,
          confirmationToken: token,
          expiresAt: expiresAt.toISOString(),
        };
      }
    }
  }

  async confirm(
    token: string,
    deviceId: string | null,
    client: ClientInfo,
  ): Promise<KioskPunchResult> {
    const now = this.clock.now();
    const claims = this.confirmations.read(token);
    if (!claims || claims.deviceId !== deviceId)
      throw this.reject(
        'CONFIRMATION_INVALID',
        'This confirmation is not valid. Enter your employee number again.',
      );

    // A retry of a confirm the server already recorded returns that punch (idempotency).
    const replay = await this.recordedFor(claims);
    if (replay) return replay;
    if (now.getTime() > claims.exp)
      throw this.reject(
        'CONFIRMATION_EXPIRED',
        'The confirmation timed out. Enter your employee number again.',
      );

    const account = await this.prisma.userAccount.findUnique({
      where: { id: claims.userId },
      select: {
        status: true,
        employee: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!account || account.employee.id !== claims.employeeId)
      throw this.reject('CONFIRMATION_INVALID', 'This confirmation is not valid.');
    if (account.status !== 'ACTIVE') throw this.inactive();

    const ctx = await this.actions.context();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockEmployee(tx, claims.employeeId);
        // A concurrent confirm of the same token (double click) committed while we waited.
        const replayed = await this.recordedFor(claims, tx);
        if (replayed) return replayed;
        // Read the clock after taking the lock so a punch committed while waiting is "before" now.
        const at = this.clock.now();
        const action = await this.actions.decide(tx, claims.employeeId, at, ctx);
        if (action.kind !== claims.action || action.workDate !== claims.workDate)
          throw this.stateChanged(action, ctx);
        return this.record(tx, {
          who: {
            userId: claims.userId,
            employeeId: claims.employeeId,
            firstName: account.employee.firstName,
            lastName: account.employee.lastName,
          },
          type: claims.action,
          workDate: claims.workDate,
          now: at,
          deviceId,
          clientUuid: claims.nonce,
          channel: 'confirm',
          client,
        });
      });
    } catch (err) {
      // The same token was confirmed concurrently: the other request recorded the punch.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const recorded = await this.recordedFor(claims);
        if (recorded) return recorded;
      }
      throw err;
    }
  }

  /** One-step punch (previous kiosk version, integrations). `type`, if sent, must match the server's decision. */
  async punch(
    input: KioskPunchInput,
    deviceId: string | null,
    client: ClientInfo,
  ): Promise<KioskPunchResult> {
    const now = this.clock.now();
    const who = await this.verify(input.accountNumber, input.pin, now, client);
    const ctx = await this.actions.context();
    return this.prisma.$transaction(async (tx) => {
      await this.lockEmployee(tx, who.employeeId);
      // Read the clock after taking the lock so a punch committed while waiting is "before" now.
      const at = this.clock.now();
      const action = await this.actions.decide(tx, who.employeeId, at, ctx);
      if (action.kind !== 'TIME_IN' && action.kind !== 'TIME_OUT')
        throw this.legacyRejection(action, input.type ?? null, ctx);
      if (input.type && input.type !== action.kind)
        throw this.legacyRejection(action, input.type, ctx);
      return this.record(tx, {
        who,
        type: action.kind,
        workDate: action.workDate,
        now: at,
        deviceId,
        clientUuid: null,
        channel: 'direct',
        client,
      });
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async verify(
    accountNumber: string,
    pin: string,
    now: Date,
    client: ClientInfo,
  ): Promise<KioskIdentity> {
    const verified = await this.identity.verify(accountNumber, pin, now, client);
    if (verified.ok) return verified.identity;
    if (verified.reason === 'LOCKED')
      throw new LockedError(
        'Too many wrong PIN attempts. Try again later or ask HR to reset your PIN.',
        verified.lockedUntil,
      );
    if (verified.reason === 'INACTIVE') throw this.inactive();
    // One message for unknown numbers and wrong PINs: never reveal which employee numbers exist.
    throw new UnauthenticatedError(ERROR_CODES.INVALID_CREDENTIALS, INVALID);
  }

  private async record(
    tx: PrismaTx,
    p: {
      who: KioskIdentity;
      type: PunchType;
      workDate: string;
      now: Date;
      deviceId: string | null;
      clientUuid: string | null;
      channel: 'confirm' | 'direct';
      client: ClientInfo;
    },
  ): Promise<KioskPunchResult> {
    const created = await tx.attendanceEvent.create({
      data: {
        employeeId: p.who.employeeId,
        type: p.type,
        occurredAt: p.now,
        recordedAt: p.now,
        workDate: dateColumn(p.workDate),
        source: 'KIOSK_ONLINE',
        deviceId: p.deviceId,
        clientUuid: p.clientUuid,
      },
    });
    await this.days.recompute(tx, p.who.employeeId, p.workDate);
    await this.audit.authEvent(
      {
        type: 'PIN_VERIFY',
        success: true,
        userId: p.who.userId,
        reason: p.type.toLowerCase(),
        client: p.client,
      },
      tx,
    );
    await this.audit.record(
      {
        actorUserId: p.who.userId,
        action: 'attendance.punch.kiosk',
        entityType: 'attendance_event',
        entityId: created.id,
        after: {
          employeeId: p.who.employeeId,
          type: p.type,
          occurredAt: p.now.toISOString(),
          workDate: p.workDate,
          deviceId: p.deviceId,
          channel: p.channel,
        },
        client: p.client,
      },
      tx,
    );
    return {
      type: p.type,
      occurredAt: created.occurredAt.toISOString(),
      workDate: p.workDate,
      displayName: displayName(p.who),
    };
  }

  private async recordedFor(
    claims: ConfirmationClaims,
    tx: PrismaTx = this.prisma,
  ): Promise<KioskPunchResult | null> {
    const event = await tx.attendanceEvent.findUnique({
      where: { clientUuid: claims.nonce },
      select: {
        employeeId: true,
        type: true,
        occurredAt: true,
        employee: { select: { firstName: true, lastName: true } },
      },
    });
    if (!event || event.employeeId !== claims.employeeId) return null;
    return {
      type: event.type,
      occurredAt: event.occurredAt.toISOString(),
      workDate: claims.workDate,
      displayName: displayName(event.employee),
    };
  }

  private stateChanged(action: KioskAction, ctx: KioskActionContext): ConflictError {
    const at = (d: Date) => this.clockTime(d, ctx);
    switch (action.kind) {
      case 'COMPLETED':
        return this.reject(
          'ALREADY_COMPLETED',
          `Your attendance for this shift is already complete (in ${at(action.timeInAt)}, out ${at(action.timeOutAt)}).`,
        );
      case 'JUST_RECORDED':
        return this.reject(
          'DUPLICATE',
          `Already recorded: ${action.type === 'TIME_IN' ? 'time in' : 'time out'} at ${at(action.at)}.`,
        );
      default:
        return this.reject(
          'STATE_CHANGED',
          'Your attendance changed since you entered your number. Please try again.',
        );
    }
  }

  private legacyRejection(
    action: KioskAction,
    requested: PunchType | null,
    ctx: KioskActionContext,
  ): ConflictError {
    const at = (d: Date) => this.clockTime(d, ctx);
    switch (action.kind) {
      case 'TIME_OUT':
        return this.reject(
          'ALREADY_TIMED_IN',
          `You are already timed in since ${at(action.timeInAt)}. Time out first.`,
        );
      case 'TIME_IN':
        return requested === 'TIME_OUT'
          ? this.reject('NOT_TIMED_IN', 'There is no open time-in to close. Time in first.')
          : this.reject('STATE_CHANGED', 'Please try again.');
      default:
        return this.stateChanged(action, ctx);
    }
  }

  private clockTime(d: Date, ctx: KioskActionContext): string {
    return DateTime.fromJSDate(d, { zone: ctx.timezone }).toFormat('h:mm a');
  }

  private reject(reason: PunchRejection, message: string): ConflictError {
    return new ConflictError(message, { reason });
  }

  private inactive(): AppError {
    return new AppError(
      ERROR_CODES.ACCOUNT_INACTIVE,
      'This account cannot record attendance. Please contact HR.',
      HttpStatus.FORBIDDEN,
    );
  }

  private async lockEmployee(tx: PrismaTx, employeeId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM employee WHERE id = ${employeeId}::uuid FOR UPDATE`;
  }
}
