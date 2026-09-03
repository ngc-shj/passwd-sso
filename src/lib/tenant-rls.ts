import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma, PrismaClient } from "@prisma/client";
import { NIL_UUID, SYSTEM_TENANT_ID, UUID_RE } from "@/lib/constants/app";
import { getLogger } from "@/lib/logger";

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

/** Why `withTenantRls` refused to open a context. */
export const RLS_CONTEXT_REFUSAL = {
  /** The value is the sentinel tenant under some spelling PostgreSQL accepts. */
  SENTINEL: "sentinel",
  /** Not a canonical UUID, so a `===` against the sentinel is not decisive. */
  NON_CANONICAL_UUID: "non_canonical_uuid",
} as const;

export type RlsContextRefusal =
  (typeof RLS_CONTEXT_REFUSAL)[keyof typeof RLS_CONTEXT_REFUSAL];

/**
 * `withTenantRls` was asked to open an RLS context it must not open.
 *
 * A named class rather than a bare Error so a caller that means to handle this
 * (there is none today) cannot end up matching on the message text, and so the
 * refusal is distinguishable from `INVALID_RLS_NESTING` at a catch site.
 */
export class RlsSentinelContextRefused extends Error {
  readonly refusal: RlsContextRefusal;

  constructor(refusal: RlsContextRefusal) {
    super(
      `RLS_SENTINEL_CONTEXT_REFUSED: withTenantRls refused to open a context (${refusal})`,
    );
    this.name = "RlsSentinelContextRefused";
    this.refusal = refusal;
  }
}

/**
 * The one caller-supplied `set_config('app.tenant_id', …)` in the tree.
 *
 * `SYSTEM_TENANT_ID` is the encoding of "no owning tenant" and is the FK target
 * of every unattributable audit row, so opening an RLS context on it hands the
 * holder every such row in the deployment. Refusing HERE rather than adding a
 * CHECK per tenant-scoped column covers all 126 `withTenantRls` call sites, the
 * ~10 `tenant_id` columns they reach, and any column added later.
 *
 * Two arms, because a JS `===` alone is not sound:
 *
 *   - PostgreSQL casts `'{00000000-…-002}'`, the unhyphenated form and the
 *     uppercase form all to the same `uuid`; JS holds none of them equal to the
 *     canonical string. `UUID_RE` rejects the first two and carries `/i`, so
 *     requiring the canonical form first is what makes the equality decisive.
 *   - Case is then the axis `UUID_RE` leaves, hence the fold. The guard is
 *     sound today only because the sentinel is digit-only; the fold keeps it
 *     sound for any future value.
 *
 * The canonical-form arm denies nothing that worked: `app.tenant_id` is read as
 * `current_setting('app.tenant_id', true)::uuid` in 112 policy expressions, so a
 * non-canonical value already raises 22P02 at the first policy evaluation.
 * Measured on the dev database — `set_config('app.tenant_id','tenant-abc')`
 * followed by a `SELECT` on `audit_logs` as `passwd_app` fails with
 * `invalid input syntax for type uuid`. This moves that failure to the context
 * open, where it names itself.
 *
 * It does NOT write an audit row, deliberately, and this is F3's stated
 * exception. Both spellings are unsafe from this position: `enqueueAudit` with
 * an explicit tenantId opens a raw `$transaction` that the Prisma Proxy folds
 * into the caller's, turning RLS off for its remainder; without one,
 * `resolveTenantId`'s `withBypassRls` is refused by the nesting guard and the
 * row is swallowed. There is also no `req`, `userId` or `ip` here to attribute
 * a row with. The sink is `getLogger()` and not `auditLogger`, which ships
 * disabled (`AUDIT_LOG_FORWARD` defaults to `false`).
 */
function assertOpenableTenantContext(tenantId: string): void {
  const canonical = UUID_RE.test(tenantId);
  if (canonical && tenantId.toLowerCase() !== SYSTEM_TENANT_ID) return;

  const refusal = canonical
    ? RLS_CONTEXT_REFUSAL.SENTINEL
    : RLS_CONTEXT_REFUSAL.NON_CANONICAL_UUID;
  getLogger().error(
    { event: "rls.sentinel_context_refused", refusal },
    "withTenantRls refused to open an RLS context",
  );
  throw new RlsSentinelContextRefused(refusal);
}

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
  // AFTER the nesting guard, so a nested call keeps reporting the nesting —
  // the outer defect — rather than being reclassified by whatever tenant id it
  // happened to carry.
  assertOpenableTenantContext(tenantId);
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
