import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma, PrismaClient } from "@prisma/client";
import { NIL_UUID } from "@/lib/constants/app";

export const BYPASS_PURPOSE = {
  AUTH_FLOW: "auth_flow",
  CROSS_TENANT_LOOKUP: "cross_tenant_lookup",
  SYSTEM_MAINTENANCE: "system_maintenance",
  AUDIT_WRITE: "audit_write",
  WEBHOOK_DISPATCH: "webhook_dispatch",
  TOKEN_LIFECYCLE: "token_lifecycle",
} as const;

export type BypassPurpose = (typeof BYPASS_PURPOSE)[keyof typeof BYPASS_PURPOSE];

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
  purpose: BypassPurpose,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.bypass_purpose', ${purpose}, true)`;
    // Set a valid UUID to prevent cast errors when PG evaluates both OR branches
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${NIL_UUID}, true)`;
    return tenantRlsStorage.run({ tx, tenantId: null, bypass: true }, fn);
  });
}
