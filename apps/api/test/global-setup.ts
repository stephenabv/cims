import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * Rebuilds the dedicated test database from migrations so tests exercise the real DDL
 * (constraints, triggers). Refuses to run against any database whose name does not end in
 * `_test`, so a misconfigured DATABASE_URL can never wipe a development or production database.
 */
export default async function globalSetup(): Promise<void> {
  await import('./test-env');
  const url = new URL(process.env.DATABASE_URL!);
  const dbName = url.pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to reset non-test database "${dbName}"`);

  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  } finally {
    await prisma.$disconnect();
  }
  execSync('npx prisma migrate deploy', {
    cwd: resolve(__dirname, '..'),
    stdio: 'pipe',
    env: process.env,
  });
}
