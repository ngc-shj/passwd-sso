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

export async function withBypassRls<T>(
  prisma: PrismaClient,
  fn: () => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return tenantRlsStorage.run({ tx, tenantId: null, bypass: true }, fn);
  });
}
