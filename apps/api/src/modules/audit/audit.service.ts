import { Injectable } from '@nestjs/common';
import { type AuthEventType, Prisma } from '@prisma/client';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import type { ClientInfo } from '../../common/http/request-context';

export interface AuditEntry {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  client?: ClientInfo;
}

export interface AuthEventEntry {
  type: AuthEventType;
  success: boolean;
  userId?: string | null;
  accountNumber?: string | null;
  reason?: string | null;
  client?: ClientInfo;
}

const SENSITIVE_KEYS = /password|pin|secret|token|hash|code/i;

/** Removes anything that looks like a credential before it reaches the audit log. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEYS.test(k) ? '[REDACTED]' : redact(v),
      ]),
    );
  }
  return value;
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined || value === null) return Prisma.JsonNull;
  return JSON.parse(
    JSON.stringify(redact(value), (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass `tx` so the audit row commits or rolls back with the change it describes. */
  async record(entry: AuditEntry, tx: PrismaTx = this.prisma): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorUserId: entry.actorUserId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: toJson(entry.before),
        after: toJson(entry.after),
        metadata: toJson(entry.metadata),
        ip: entry.client?.ip ?? null,
        requestId: entry.client?.requestId ?? null,
      },
    });
  }

  async authEvent(entry: AuthEventEntry, tx: PrismaTx = this.prisma): Promise<void> {
    await tx.authEvent.create({
      data: {
        type: entry.type,
        success: entry.success,
        userId: entry.userId ?? null,
        accountNumber: entry.accountNumber?.slice(0, 50) ?? null,
        reason: entry.reason ?? null,
        ip: entry.client?.ip ?? null,
        userAgent: entry.client?.userAgent ?? null,
      },
    });
  }
}
