import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ValidationError } from '../../common/errors/app-error';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  SETTING_DEFINITIONS,
  type SettingKey,
  type SettingValue,
  isSettingKey,
} from './setting-definitions';

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Returns the stored value, falling back to the default if missing or no longer valid. */
  async get<K extends SettingKey>(key: K, tx: PrismaTx = this.prisma): Promise<SettingValue<K>> {
    const def = SETTING_DEFINITIONS[key];
    const row = await tx.companySetting.findUnique({ where: { key } });
    if (!row) return def.default as SettingValue<K>;
    const parsed = def.schema.safeParse(row.value);
    return (parsed.success ? parsed.data : def.default) as SettingValue<K>;
  }

  async getMany<K extends SettingKey>(keys: readonly K[]): Promise<{ [P in K]: SettingValue<P> }> {
    const rows = await this.prisma.companySetting.findMany({ where: { key: { in: [...keys] } } });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const out = {} as { [P in K]: SettingValue<P> };
    for (const key of keys) {
      const def = SETTING_DEFINITIONS[key];
      const parsed = def.schema.safeParse(byKey.get(key));
      out[key] = (parsed.success ? parsed.data : def.default) as SettingValue<K>;
    }
    return out;
  }

  async getAll(): Promise<Record<SettingKey, unknown>> {
    return this.getMany(Object.keys(SETTING_DEFINITIONS) as SettingKey[]);
  }

  async set(key: string, value: unknown, actorUserId: string): Promise<void> {
    if (!isSettingKey(key))
      throw new ValidationError([{ path: 'key', message: `Unknown setting ${key}` }]);
    const parsed = SETTING_DEFINITIONS[key].schema.safeParse(value);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => ({
          path: ['value', ...i.path].join('.'),
          message: i.message,
        })),
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const before = await this.get(key, tx);
      const json = parsed.data as Prisma.InputJsonValue;
      await tx.companySetting.upsert({
        where: { key },
        create: { key, value: json, updatedById: actorUserId },
        update: { value: json, updatedById: actorUserId },
      });
      await this.audit.record(
        {
          actorUserId,
          action: 'settings.update',
          entityType: 'company_setting',
          entityId: key,
          before,
          after: parsed.data,
        },
        tx,
      );
    });
  }
}
