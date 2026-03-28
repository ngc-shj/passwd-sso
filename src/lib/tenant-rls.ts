import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma, PrismaClient } from "@prisma/client";

type TenantRlsContext = {
  tx: Prisma.TransactionClient;
  tenantId: string | null;
  bypass: boolean;
};

const tenantRlsStorage = new AsyncLocalStorage<TenantRlsContext>();

export function getTenantRlsContext(): TenantRlsContext | undefined {
  return tenantRlsStorage.getStore();
}

export async function withTenantRls<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return tenantRlsStorage.run({ tx, tenantId, bypass: false }, fn);
  });
}

// Nil UUID used as safe default for app.tenant_id to prevent
// "invalid input syntax for type uuid" errors in RLS policy evaluation.
// PostgreSQL does NOT guarantee short-circuit evaluation of OR in policies,
// so even when app.bypass_rls = 'on', the tenant_id comparison may execute.
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export async function withBypassRls<T>(
  prisma: PrismaClient,
  fn: () => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    // Set a valid UUID to prevent cast errors when PG evaluates both OR branches
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${NIL_UUID}, true)`;
    return tenantRlsStorage.run({ tx, tenantId: null, bypass: true }, fn);
  });
}
