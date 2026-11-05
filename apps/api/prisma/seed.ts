/**
 * Idempotent seed: permissions, default roles, and a bootstrap IT administrator (only when no
 * IT administrator exists). Safe to re-run; it never overwrites edited role permissions.
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomInt } from 'node:crypto';
import { ALL_PERMISSION_CODES, SYSTEM_ROLES, isWeakPin, passwordSchema } from '@cims/shared';
import { DEFAULT_ROLES, PERMISSION_DESCRIPTIONS } from '../src/modules/access/default-roles';

const prisma = new PrismaClient();

async function seedPermissionsAndRoles(): Promise<void> {
  for (const code of ALL_PERMISSION_CODES) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, description: PERMISSION_DESCRIPTIONS[code] },
      update: { description: PERMISSION_DESCRIPTIONS[code] },
    });
  }
  for (const role of DEFAULT_ROLES) {
    const existing = await prisma.role.findUnique({ where: { key: role.key } });
    if (existing) continue; // Respect runtime edits.
    await prisma.role.create({
      data: {
        key: role.key,
        name: role.name,
        description: role.description,
        isSystem: true,
        requiresMfa: role.requiresMfa,
        permissions: { create: role.permissions.map((permissionCode) => ({ permissionCode })) },
      },
    });
  }
}

async function seedBootstrapAdmin(): Promise<void> {
  const itRole = await prisma.role.findUniqueOrThrow({ where: { key: SYSTEM_ROLES.IT_ADMIN } });
  if (await prisma.userAccount.count({ where: { roleId: itRole.id } })) return;

  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password)
    throw new Error(
      'BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are required for the first seed',
    );
  if (!passwordSchema.safeParse(password).success)
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD does not satisfy the password policy');

  const domain = email.split('@')[1]!;
  await prisma.companySetting.upsert({
    where: { key: 'company.allowedEmailDomains' },
    create: { key: 'company.allowedEmailDomains', value: [domain] },
    update: {},
  });

  const department = await prisma.department.upsert({
    where: { code: 'IT' },
    create: { code: 'IT', name: 'Information Technology' },
    update: {},
  });

  let pin: string;
  do pin = randomInt(0, 1_000_000).toString().padStart(6, '0');
  while (isWeakPin(pin));

  await prisma.$transaction(async (tx) => {
    const [{ nextval }] = await tx.$queryRaw<
      [{ nextval: bigint }]
    >`SELECT nextval('employee_account_number_seq')`;
    const accountNumber = `EMP-${nextval.toString().padStart(6, '0')}`;
    const employee = await tx.employee.create({
      data: {
        accountNumber,
        firstName: 'System',
        lastName: 'Administrator',
        companyEmail: email,
        departmentId: department.id,
        classification: 'REGULAR',
        dateHired: new Date(),
      },
    });
    await tx.userAccount.create({
      data: {
        employeeId: employee.id,
        roleId: itRole.id,
        status: 'ACTIVE',
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        // Force rotation of the bootstrap secret on first sign-in.
        mustChangePassword: true,
        pinHash: await argon2.hash(pin, { type: argon2.argon2id }),
      },
    });
    await tx.auditLog.create({
      data: { action: 'seed.bootstrap_admin', entityType: 'employee', entityId: employee.id },
    });
    console.warn(
      `Bootstrap IT administrator created: ${accountNumber} (${email}). Change the password at first sign-in.`,
    );
  });
}

async function main(): Promise<void> {
  await seedPermissionsAndRoles();
  await seedBootstrapAdmin();
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
