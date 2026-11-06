import type { PrismaClient } from '@prisma/client';
import { SYSTEM_ROLES } from '@cims/shared';

export const DEFAULT_CHAIN_NAME = 'Supervisor then HR';

/**
 * Creates the default leave approval chain (supervisor, then HR; spec §3.3) when no chain exists.
 * Runs from the seed because it references the HR role, which the seed creates. Idempotent and
 * never overwrites a chain an administrator has edited.
 */
export async function ensureDefaultApprovalChain(prisma: PrismaClient): Promise<void> {
  if (await prisma.approvalChain.count()) return;
  const hr = await prisma.role.findUniqueOrThrow({ where: { key: SYSTEM_ROLES.HR } });
  await prisma.approvalChain.create({
    data: {
      name: DEFAULT_CHAIN_NAME,
      isDefault: true,
      steps: {
        create: [
          { position: 1, kind: 'SUPERVISOR' },
          { position: 2, kind: 'ROLE', roleId: hr.id },
        ],
      },
    },
  });
}
