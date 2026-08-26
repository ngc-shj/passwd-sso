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
  AUDIT_ANCHOR_PUBLISH: "audit-anchor-publish",
} as const;

export type BypassPurpose = (typeof BYPASS_PURPOSE)[keyof typeof BYPASS_PURPOSE];

type TenantRlsContext = {
  tx: Prisma.TransactionClient;
  tenantId: string | null;
  bypass: boolean;
};

export const tenantRlsStorage = new AsyncLocalStorage<TenantRlsContext>();

export function getTenantRlsContext(): TenantRlsContext | undefined {
  return tenantRlsStorage.getStore();
}

export function isBypassRlsActive(): boolean {
  return getTenantRlsContext()?.bypass === true;
}

export async function withTenantRls<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  // Additive and optional: every existing caller keeps Prisma's defaults
  // (5s timeout / 2s maxWait). Pass an explicit budget where the work inside
  // is bounded by something other than a single quick statement — a batch read
  // sized by an operator-tunable cap, for instance.
  options?: { timeout?: number; maxWait?: number },
): Promise<T> {
  // Symmetric nesting guard: AsyncLocalStorage does NOT roll back PostgreSQL
  // GUCs, and the Prisma Proxy folds nested $transaction into the outer tx,
  // so set_config() from either direction persists for the outer transaction's
  // remainder. Rejecting nesting in both directions is the only correct fix.
  if (getTenantRlsContext()?.bypass === true) {
    throw new Error(
      "INVALID_RLS_NESTING: withTenantRls inside withBypassRls is forbidden",
    );
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return tenantRlsStorage.run({ tx, tenantId, bypass: false }, () => fn(tx));
  }, options);
}


export async function withBypassRls<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  purpose: BypassPurpose,
  // Additive and optional, same contract as withTenantRls: every existing
  // caller keeps Prisma's defaults (5s timeout / 2s maxWait). One-shot
  // migrations that rewrite a batch inside a single bypass transaction need an
  // explicit budget — the work there is sized by a batch constant, not by a
  // single quick statement.
  options?: { timeout?: number; maxWait?: number },
): Promise<T> {
  if (getTenantRlsContext()?.bypass === false) {
    throw new Error(
      "INVALID_RLS_NESTING: withBypassRls inside withTenantRls is forbidden",
    );
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.bypass_purpose', ${purpose}, true)`;
    // Set a valid UUID to prevent cast errors when PG evaluates both OR branches
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${NIL_UUID}, true)`;
    return tenantRlsStorage.run({ tx, tenantId: null, bypass: true }, () => fn(tx));
  }, options);
}

/**
 * Acquire a transaction-scoped PostgreSQL advisory lock keyed by an arbitrary
 * string. MUST be called inside an open transaction (withTenantRls /
 * withBypassRls / prisma.$transaction) — the lock auto-releases at tx end. Used
 * to serialize concurrent "count/aggregate → check cap → create" sequences for
 * the same key so two requests cannot both read count < cap and both create
 * (TOCTOU). See scripts/checks/check-count-then-create-lock.mjs.
 *
 * SECURITY: `key` is bound as a Prisma tagged-template parameter, so the emitted
 * SQL is `SELECT pg_advisory_xact_lock(hashtext($1::text))` — `key` is NEVER
 * string-concatenated into SQL and cannot inject. Extracting this single verbatim
 * statement (previously inlined at every call site) keeps the injection-safety
 * reasoning in one reviewed place; the emitted SQL and thus the lock identity are
 * byte-identical to the inlined form.
 */
export async function advisoryXactLock(
  client: Pick<Prisma.TransactionClient, "$executeRaw">,
  key: string,
): Promise<void> {
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}::text))`;
}
