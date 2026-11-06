import { Injectable } from '@nestjs/common';
import type {
  PayItemTypeInput,
  PayItemTypeView,
  UndertimePolicyInput,
  UndertimePolicyView,
  UndertimeTier,
} from '@cims/shared';
import { Prisma } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import type { AuthContext, ClientInfo } from '../../common/http/request-context';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

type PolicyRow = Prisma.UndertimePolicyGetPayload<object>;
type TypeRow = Prisma.PayItemTypeGetPayload<object>;

export const policyView = (p: PolicyRow): UndertimePolicyView => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  blockMinutes: p.blockMinutes,
  amountPerBlockCentavos: p.amountPerBlockCentavos,
  chargePartialBlock: p.chargePartialBlock,
  tiers: (p.tiers as UndertimeTier[] | null) ?? null,
  isDefault: p.isDefault,
  isActive: p.isActive,
});

export const payItemTypeView = (t: TypeRow): PayItemTypeView => ({
  id: t.id,
  code: t.code,
  name: t.name,
  direction: t.direction,
  isActive: t.isActive,
});

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Company payroll rules (spec §3.4): undertime deduction policies and the kinds of allowances
 * and deductions (owner decision on Q-2: statutory contributions are configured, not computed).
 */
@Injectable()
export class PayrollConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Undertime policies ─────────────────────────────────────────────────────

  async policies(): Promise<UndertimePolicyView[]> {
    const rows = await this.prisma.undertimePolicy.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    return rows.map(policyView);
  }

  async savePolicy(
    actor: AuthContext,
    id: string | null,
    input: UndertimePolicyInput,
    client: ClientInfo,
  ): Promise<UndertimePolicyView> {
    const data = {
      ...input,
      tiers: input.tiers ? (input.tiers as Prisma.InputJsonValue) : Prisma.DbNull,
    };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = id ? await tx.undertimePolicy.findUnique({ where: { id } }) : null;
        if (id && !before) throw new NotFoundError('Undertime policy');
        if (before?.isDefault && !input.isActive)
          throw new ConflictError('The default policy cannot be deactivated');
        const saved = id
          ? await tx.undertimePolicy.update({ where: { id }, data })
          : await tx.undertimePolicy.create({ data });
        await this.audit.record(
          {
            actorUserId: actor.userId,
            action: id ? 'payroll.undertime_policy.update' : 'payroll.undertime_policy.create',
            entityType: 'undertime_policy',
            entityId: saved.id,
            before: before ? policyView(before) : null,
            after: policyView(saved),
            client,
          },
          tx,
        );
        return policyView(saved);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictError('A policy with this name already exists');
      throw e;
    }
  }

  /** The policy new profiles start with. */
  async makeDefaultPolicy(
    actor: AuthContext,
    id: string,
    client: ClientInfo,
  ): Promise<UndertimePolicyView[]> {
    await this.prisma.$transaction(async (tx) => {
      const policy = await tx.undertimePolicy.findUnique({ where: { id } });
      if (!policy) throw new NotFoundError('Undertime policy');
      if (!policy.isActive) throw new ConflictError('Activate the policy first');
      await tx.undertimePolicy.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
      await tx.undertimePolicy.update({ where: { id }, data: { isDefault: true } });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'payroll.undertime_policy.make_default',
          entityType: 'undertime_policy',
          entityId: id,
          client,
        },
        tx,
      );
    });
    return this.policies();
  }

  // ── Allowance and deduction types ──────────────────────────────────────────

  async itemTypes(): Promise<PayItemTypeView[]> {
    const rows = await this.prisma.payItemType.findMany({
      orderBy: [{ direction: 'asc' }, { name: 'asc' }],
    });
    return rows.map(payItemTypeView);
  }

  async saveItemType(
    actor: AuthContext,
    id: string | null,
    input: PayItemTypeInput,
    client: ClientInfo,
  ): Promise<PayItemTypeView> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = id ? await tx.payItemType.findUnique({ where: { id } }) : null;
        if (id && !before) throw new NotFoundError('Pay item type');
        if (
          before &&
          before.direction !== input.direction &&
          (await tx.employeePayItem.count({ where: { typeId: id! } }))
        )
          throw new ConflictError(
            'This type is already used; create a new type instead of switching allowance and deduction',
          );
        const saved = id
          ? await tx.payItemType.update({ where: { id }, data: input })
          : await tx.payItemType.create({ data: input });
        await this.audit.record(
          {
            actorUserId: actor.userId,
            action: id ? 'payroll.item_type.update' : 'payroll.item_type.create',
            entityType: 'pay_item_type',
            entityId: saved.id,
            before: before ? payItemTypeView(before) : null,
            after: payItemTypeView(saved),
            client,
          },
          tx,
        );
        return payItemTypeView(saved);
      });
    } catch (e) {
      if (isUniqueViolation(e))
        throw new ConflictError('A type with this code or name already exists');
      throw e;
    }
  }
}
