import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma, PrismaClient } from "@prisma/client";
import { SYSTEM_TENANT_ID, UUID_RE } from "@/lib/constants/app";
import { getLogger } from "@/lib/logger";
import { pinBypassOff, setBypassGucs, type BypassGrant } from "@/lib/tenant-rls-grants";

export { BYPASS_PURPOSE, type BypassPurpose } from "@/lib/tenant-rls-purpose";

type TenantRlsContext = {
  tx: Prisma.TransactionClient;
  tenantId: string | null;
  bypass: boolean;
  /**
   * Set when a nested context was refused inside this one. The context's own
   * helper then fails its transaction, so a caller that caught the refusal
   * cannot commit work that skipped what the nested context was for.
   */
  refusedNesting: boolean;
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
 * Log a guard's refusal without letting the logger decide the outcome. The
 * guards below throw their own error after logging; a logger that throws
 * (`getLogger()` itself, or `.error`) would otherwise replace that error with
 * its own, and a caller matching on the refusal would no longer see one. The
 * refusal is the security control and always reaches the caller; a failed log
 * line is dropped.
 */
function logRefusal(fields: Record<string, string>, message: string): void {
  try {
    getLogger().error(fields, message);
  } catch {
    // Logging must not change what the guard throws.
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
 * It does NOT write an audit row, and the two reasons this used to give are both
 * gone — recorded here because a stale reason is what stops the next editor
 * noticing. `enqueueAudit` no longer folds into the caller's transaction (it
 * opens on the un-proxied client), and `resolveTenantId`'s `withBypassRls` is no
 * longer "refused by the nesting guard" from this position: the guard runs
 * BEFORE this function, so reaching here means no context is active at all.
 *
 * What remains true is narrower: there is no `req`, `userId` or `ip` here to
 * attribute a row with, and the sink is `getLogger()` rather than `auditLogger`,
 * which ships disabled (`AUDIT_LOG_FORWARD` defaults to `false`). Whether this
 * refusal — an attempt to open a context on the tenant that owns every
 * unattributable audit row — should itself be audited is an open question, not a
 * settled "no".
 */
function assertOpenableTenantContext(tenantId: string): void {
  const canonical = UUID_RE.test(tenantId);
  if (canonical && tenantId.toLowerCase() !== SYSTEM_TENANT_ID) return;

  const refusal = canonical
    ? RLS_CONTEXT_REFUSAL.SENTINEL
    : RLS_CONTEXT_REFUSAL.NON_CANONICAL_UUID;
  logRefusal(
    { event: "rls.sentinel_context_refused", refusal },
    "withTenantRls refused to open an RLS context",
  );
  throw new RlsSentinelContextRefused(refusal);
}

/**
 * Refuse to open an RLS context while another is active — in ALL FOUR
 * combinations, which is what the guard's comment used to claim while it
 * implemented two.
 *
 * AsyncLocalStorage does NOT roll a PostgreSQL GUC back when its scope exits,
 * and the Prisma Proxy folds a nested `$transaction` into the outer one — so a
 * `set_config` issued by an inner context persists for the OUTER transaction's
 * remainder, whichever direction the nesting runs. The same-kind pairs were
 * benign only because no live site nested two DIFFERENT tenants; that is a
 * property of today's call sites, not of the mechanism.
 *
 * The message names both halves so a failure says which nesting occurred, and
 * keeps the `INVALID_RLS_NESTING:` prefix the existing assertions match on.
 *
 * A caller that swallows the refusal no longer skips its work silently: the
 * refusal marks the active context, and that context's own helper fails its
 * transaction when its callback returns (runContext), so the request fails
 * instead. Two cases stay detection-only, through the error log below: work
 * detached from the callback that opens a context after the outer one
 * committed, and an outer call that is itself caught. The log names only the
 * two helpers: no tenant id, SQL or caller argument reaches it. This guard is
 * the boundary; check-rls-nesting is a limited development aid that reports
 * the nesting it can see, with the coverage its header lists.
 */
function assertNoActiveRlsContext(opening: "withTenantRls" | "withBypassRls"): void {
  const ctx = getTenantRlsContext();
  if (ctx === undefined) return;
  const active = ctx.bypass ? "withBypassRls" : "withTenantRls";
  ctx.refusedNesting = true;
  logRefusal(
    { event: "rls.nesting_refused", opening, active },
    "RLS context refused: another RLS context is active",
  );
  throw new Error(
    `INVALID_RLS_NESTING: ${opening} inside ${active} is forbidden`,
  );
}

/**
 * Run `fn` as the context's body and fail if a nested context was refused
 * inside it, even when `fn` caught that refusal. Throwing here, inside the
 * `$transaction` callback, rolls the transaction back. An error from `fn`
 * itself takes precedence: it already rolls back and names the real cause.
 *
 * Limits: work detached from `fn` (`void (async () => …)()`) that opens a
 * context after `fn` resolved is refused and logged but cannot fail a
 * transaction that already committed; and an outer call that is itself caught
 * still lets its caller continue.
 */
async function runContext<T>(ctx: TenantRlsContext, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const result = await tenantRlsStorage.run(ctx, () => fn(ctx.tx));
  if (ctx.refusedNesting) {
    const helper = ctx.bypass ? "withBypassRls" : "withTenantRls";
    throw new Error(`INVALID_RLS_NESTING: a nested RLS context was refused inside this ${helper}`);
  }
  return result;
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
  assertNoActiveRlsContext("withTenantRls");
  // AFTER the nesting guard, so a nested call keeps reporting the nesting —
  // the outer defect — rather than being reclassified by whatever tenant id it
  // happened to carry.
  assertOpenableTenantContext(tenantId);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    // A bypass GUC left on the connection by anything else must not turn this
    // tenant transaction into a bypass.
    await pinBypassOff(tx);
    return runContext({ tx, tenantId, bypass: false, refusedNesting: false }, fn);
  }, options);
}


export async function withBypassRls<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  // The purpose and the tables this bypass may reach (src/lib/tenant-rls-grants.ts).
  grant: BypassGrant,
  // Additive and optional, same contract as withTenantRls: every existing
  // caller keeps Prisma's defaults (5s timeout / 2s maxWait). One-shot
  // migrations that rewrite a batch inside a single bypass transaction need an
  // explicit budget — the work there is sized by a batch constant, not by a
  // single quick statement.
  options?: { timeout?: number; maxWait?: number },
): Promise<T> {
  assertNoActiveRlsContext("withBypassRls");
  return prisma.$transaction(async (tx) => {
    await setBypassGucs(tx, grant);
    return runContext({ tx, tenantId: null, bypass: true, refusedNesting: false }, fn);
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
