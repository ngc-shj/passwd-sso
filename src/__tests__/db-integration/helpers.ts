/**
 * Shared helpers for real-DB integration tests.
 *
 * Each test file should call createTestContext() in beforeAll and
 * ctx.cleanup() in afterAll. Within each test, use ctx.createTenant()
 * to get an isolated tenant UUID and ctx.deleteTestData(tenantId) in afterEach.
 *
 * Per-test cleanup is a best effort, not the guarantee: a trailing
 * deleteTestData line is skipped the moment an assertion above it throws.
 * ctx.cleanup() therefore sweeps every tenant createTenant() handed out and
 * deleteTestData() never removed, so a failed test cannot leak rows onto the
 * shared dev database.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { randomUUID, randomBytes } from "node:crypto";
import { pgErrorCode } from "@/lib/prisma/prisma-error";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";

// ─── Role connection strings ────────────────────────────────────

type TestRole = "superuser" | "app" | "worker" | "retention-gc-worker";

function getConnectionString(role: TestRole): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is not set");

  switch (role) {
    case "superuser":
      // Use MIGRATION_DATABASE_URL if available, otherwise fall back to DATABASE_URL
      return process.env.MIGRATION_DATABASE_URL ?? base;
    case "app":
      return (
        process.env.APP_DATABASE_URL ??
        base.replace(
          /\/\/[^:]+:[^@]+@/,
          "//passwd_app:passwd_app_pass@",
        )
      );
    case "worker":
      return (
        process.env.OUTBOX_WORKER_DATABASE_URL ??
        base.replace(
          /\/\/[^:]+:[^@]+@/,
          "//passwd_outbox_worker:passwd_outbox_pass@",
        )
      );
    case "retention-gc-worker":
      return (
        process.env.RETENTION_GC_DATABASE_URL ??
        base.replace(
          /\/\/[^:]+:[^@]+@/,
          "//passwd_retention_gc_worker:passwd_retention_gc_pass@",
        )
      );
  }
}

/**
 * The connection string for the least-privilege APPLICATION role.
 *
 * Exported because a test that needs a FRESH connection — one whose session
 * GUCs have never been set — cannot use `ctx.app.prisma`, which is pooled, and
 * the obvious substitute is wrong: `process.env.DATABASE_URL` names the
 * SUPERUSER in CI (`ci-integration.yml` sets it to `postgres`) and `passwd_app`
 * locally. A privilege-denial case built on it therefore asserts nothing in CI,
 * where the statement simply succeeds — which is exactly how two `42501` cases
 * passed every local run and failed on the branch's first CI run.
 *
 * Use this, and assert the connected principal, for any case whose subject is
 * an ACL rather than behaviour.
 */
export function appConnectionString(): string {
  return getConnectionString("app");
}

// ─── Prisma client factory ──────────────────────────────────────

export interface PrismaWithPool {
  prisma: PrismaClient;
  pool: pg.Pool;
}

/**
 * `opts.max` pins the pool size. Pass `max: 1` when a test needs two
 * statements to land on the SAME backend connection, because it is exercising
 * connection-scoped state (a custom GUC surviving a transaction, a session
 * setting). At the default size serial statements happen to reuse one
 * connection anyway — pg-pool checks out from a LIFO idle stack — but that is
 * an implementation detail, not a guarantee. `max: 1` turns it into one.
 */
export function createPrismaForRole(
  role: TestRole,
  opts?: { max?: number },
): PrismaWithPool {
  const pool = new pg.Pool({
    connectionString: getConnectionString(role),
    max: opts?.max ?? 3,
    idleTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });
  return { prisma, pool };
}

// ─── Bypass RLS GUC helper ──────────────────────────────────────

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function setBypassRlsGucs(client: any): Promise<void> {
  await client.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
  await client.$executeRaw`SELECT set_config('app.bypass_purpose', 'audit_write', true)`;
  await client.$executeRaw`SELECT set_config('app.tenant_id', ${NIL_UUID}, true)`;
}

/**
 * Retry a cleanup transaction that lost a deadlock or a serialisation
 * check (round-3 M4).
 *
 * The FK-safe ordering below closes the window where the live
 * audit-outbox-worker re-creates an `audit_logs` child after we deleted it.
 * It cannot close the LOCK-ORDER window: this transaction and the worker
 * touch the same `audit_outbox` rows, the same `audit_logs` rows and the
 * same `tenants` row, and the worker's acquisition order is not ours to
 * choose. Reordering our side is not a fix either — it relocates the cycle
 * rather than removing it, and each relocation has to be re-derived against
 * whatever the worker does next.
 *
 * Deliberately NOT claiming a specific cycle: the exact interleaving behind
 * the observed 40P01 was not reproduced, and asserting a mechanism that has
 * not been traced is how the last two rounds' wrong diagnoses happened. What
 * IS certain is the property the remedy needs: a conflict with a concurrent
 * writer is transient — Postgres kills exactly one side of a deadlock, and a
 * child row inserted a moment ago is gone once the retry deletes it. The
 * retry is bounded, so a genuine repeatable conflict (a real FK ordering bug
 * in the list below, say) still surfaces as a failure instead of hanging.
 *
 * Local-only in practice — CI runs no worker container (D-24) — but the
 * retry costs nothing there and removes a class of flake that has already
 * cost one review round chasing it in the tests.
 */
export const RETRYABLE_CLEANUP_SQLSTATES = [
  "40P01", // deadlock_detected
  "40001", // serialization_failure
  // foreign_key_violation. Included for the SAME reason, and it is the
  // failure D-24 actually recorded: the worker inserts an `audit_logs` child
  // for a tenant whose parent row this transaction is about to delete. The
  // ordering below removes the window it can do that in from the outbox
  // side, but an insert that landed just before we started still leaves a
  // child. A retry re-runs the whole delete, which now sees and removes that
  // child first. A REAL ordering bug in the list above fails all four
  // attempts identically, so this cannot mask one.
  "23503",
] as const;

/**
 * Reads the SQLSTATE from where Prisma actually puts it, rather than searching
 * the whole error for the digits (round-4 T10).
 *
 * A substring match over `message + JSON.stringify(meta)` looked equivalent
 * and is not: `meta` carries the failing query text and its bound parameters,
 * so a tenant id, claim or slug that happens to contain `23503` would make an
 * unrelated, permanent failure look transient — and the retry would then hide
 * it behind four attempts and a warning. The pg driver adapter nests the code
 * at `meta.driverAdapterError.cause.code`; other paths render it into the
 * message in Prisma's own `Code: \`23503\`` form. Both are read positionally.
 *
 * Exported for reuse: any test asserting a specific SQLSTATE from a Prisma
 * call (not only this file's own retry classifier) should read it through
 * here rather than growing a second positional parser.
 *
 * The parser itself now lives in `src/lib/prisma/prisma-error.ts`, because
 * production needed the same reading and grew a second one that handled only
 * `meta.code` — so `checkAuditOutbox`'s 42P01 branch was green in unit tests
 * and dead against the shape measured here. Two parsers deciding one predicate
 * is the defect; this is the thinner half of the fix. `pgErrorCode` is a
 * superset: it also reads a direct `err.code` and `err.cause.code`, which can
 * only turn a `null` here into a real SQLSTATE — and for
 * `isRetryableCleanupConflict` that means classifying a driver error it
 * previously could not see, never reclassifying one it already read.
 */
export const sqlStateOf = pgErrorCode;

/**
 * Tags a `tenant_claim_events` purge failure inside `deleteTestData` (QA-3a).
 * Keying the sweep's fatal/non-fatal split on this class, rather than on a
 * message-prefix string, means rewording the message can never silently
 * degrade the abort into warn-and-continue — the one outcome that would leave
 * an undeletable row on the shared dev database unreported.
 */
export class TenantClaimEventsPurgeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TenantClaimEventsPurgeError";
  }
}

export function isRetryableCleanupConflict(error: unknown): boolean {
  const sqlState = sqlStateOf(error);
  return sqlState !== null && (RETRYABLE_CLEANUP_SQLSTATES as readonly string[]).includes(sqlState);
}

export async function withCleanupConflictRetry<T>(fn: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 4;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryableCleanupConflict(e)) throw e;
      lastError = e;
      // Announced, not silent. A retry means a concurrent writer really did
      // conflict with the cleanup, which is exactly the condition this
      // helper exists to survive — and a run where it never fires is a run
      // that proves nothing about the retry. Without the line, "the suite
      // is green" could equally mean "the retry works" or "the race did not
      // happen today", and the two need different follow-ups.
      console.warn(
        `[db-integration] cleanup conflict on attempt ${attempt}, retrying: ` +
          `${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
      );
      // Linear backoff: the competing party is a 1s-poll worker, so a short
      // wait is enough for its transaction to finish and release.
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
  throw lastError;
}

/**
 * The sweep loop `sweepOutstandingTenants` runs, factored out so the
 * failure-handling mechanism (QA-3) can be driven directly with a fabricated
 * `deleteTestData`, rather than relying on the real cross-process race that
 * produces a genuine tenant_claim_events purge failure — which, like the
 * deadlock round-3 M4's retry exists for, does not happen on demand.
 *
 * A `TenantClaimEventsPurgeError` is fatal (QA-3a: keyed on the class, not on
 * message text) but does NOT abort the loop early (QA-3b): every other leaked
 * tenant still gets its own sweep attempt and the accumulated report is still
 * printed, so one purge failure cannot hide the other leaks it would
 * otherwise cost the suite its only signal about. It is re-thrown only after
 * the loop finishes.
 */
/**
 * The shape `cleanup()` runs — sweep, then disconnect in `finally` regardless
 * of whether the sweep threw (QA-3c). Factored out, same reasoning as
 * `sweepLeakedTenants` above: `cleanup()`'s own sweep and disconnects need a
 * live DB and real pools, which a sweep failure does not happen on demand
 * against, so the try/finally MECHANISM is driven here with both arguments
 * fabricated rather than against the real ones.
 */
export async function runCleanupSweep(
  sweep: () => Promise<void>,
  disconnectAll: () => Promise<void>,
): Promise<void> {
  try {
    await sweep();
  } finally {
    await disconnectAll();
  }
}

export async function sweepLeakedTenants(
  leaked: readonly string[],
  deleteTestData: (tenantId: string) => Promise<void>,
): Promise<void> {
  if (leaked.length === 0) return;
  const unresolved: string[] = [];
  const fatal: TenantClaimEventsPurgeError[] = [];
  for (const tenantId of leaked) {
    try {
      await deleteTestData(tenantId);
    } catch (e) {
      if (e instanceof TenantClaimEventsPurgeError) {
        fatal.push(e);
        continue;
      }
      unresolved.push(`${tenantId} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  console.warn(
    `[db-integration] swept ${leaked.length - unresolved.length - fatal.length} leaked test tenant(s) left by a failed test.`,
  );
  if (unresolved.length > 0) {
    console.warn(
      `[db-integration] could NOT delete ${unresolved.length} test tenant(s) — they remain on the shared database:\n  ${unresolved.join("\n  ")}`,
    );
  }
  if (fatal.length > 0) {
    console.warn(
      `[db-integration] ${fatal.length} tenant(s) left UNDELETABLE tenant_claim_events rows on the shared database (append-only — nothing but the purge routine can remove them):\n  ${fatal.map((e) => e.message).join("\n  ")}`,
    );
    throw fatal.length === 1
      ? fatal[0]
      : new AggregateError(fatal, `${fatal.length} tenant_claim_events purge failures during sweep`);
  }
}

// ─── Test context ───────────────────────────────────────────────

export interface TestContext {
  /** Superuser (passwd_user) — for DDL, data setup, privilege queries */
  su: PrismaWithPool;
  /** App role (passwd_app) — for RLS enforcement tests */
  app: PrismaWithPool;
  /** Worker role (passwd_outbox_worker) — for privilege enumeration */
  worker: PrismaWithPool;
  /** Retention-GC-worker role (passwd_retention_gc_worker) — for sweeper privilege tests (C7/C10) */
  retentionWorker: PrismaWithPool;
  /** Create a tenant row and return its UUID (swept by cleanup() if never deleted) */
  createTenant: () => Promise<string>;
  /**
   * Put a tenant this context did NOT create under the same sweep.
   *
   * Round-3 M8: `createTenant()` is not the only way a test brings a tenant
   * into existence. A test that exercises `findOrCreateTenantForClaim` — the
   * production path — gets a tenant id back from code that never touched this
   * helper, so the sweep could not see it and a failed assertion leaked the
   * tenant AND its `UNIQUE(claim)` row onto the shared dev database, where the
   * claim row then collides with the next run of the same test.
   *
   * Call this with any id obtained that way, as soon as it is known.
   */
  trackTenant: (tenantId: string) => void;
  /** Create a user row belonging to a tenant and return its UUID */
  createUser: (tenantId: string) => Promise<string>;
  /** Delete all test data for a tenant (FK-safe order) */
  deleteTestData: (tenantId: string) => Promise<void>;
  /** Sweep any tenant createTenant() handed out and never deleted, then disconnect all pools */
  cleanup: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const su = createPrismaForRole("superuser");
  const app = createPrismaForRole("app");
  const worker = createPrismaForRole("worker");
  const retentionWorker = createPrismaForRole("retention-gc-worker");

  // Verify connectivity
  await su.prisma.$executeRaw`SELECT 1`;

  // Two preconditions for C1's tenant_claim_events purge routine (SC11 /
  // #743's testing strategy), probed ONCE here rather than surfacing as a
  // cryptic driver error out of every file's deleteTestData()/afterEach.
  // Probed as CAPABILITIES, not titles: neither check asks "is this role
  // the table owner" — an ownership predicate would fail every one of the
  // ~95 integration files on a working configuration where
  // MIGRATION_DATABASE_URL points at a superuser that is not the owner, and
  // a probe sitting in front of the whole suite is exactly the kind that
  // gets deleted rather than corrected.
  //
  // Order matters. "Not migrated" must be told apart from "not privileged"
  // BEFORE the privilege probe: a checked-out-but-unmigrated branch raises
  // 42883 (undefined_function), which is not in RETRYABLE_CLEANUP_SQLSTATES,
  // out of every deleteTestData() call in every file — so the useful message
  // ("run npm run db:migrate") has to win in that case, not a privilege
  // error that is not the actual problem.
  const [{ purgeRoutineExists }] = await su.prisma.$queryRaw<{ purgeRoutineExists: boolean }[]>`
    SELECT to_regprocedure('public.tenant_claim_events_purge_for_tenant(uuid)') IS NOT NULL AS "purgeRoutineExists"
  `;
  if (!purgeRoutineExists) {
    throw new Error(
      "[db-integration] tenant_claim_events_purge_for_tenant does not exist on this database. " +
        "Run `npm run db:migrate` to apply " +
        "prisma/migrations/20260731100000_add_tenant_claim_events, then re-run the suite.",
    );
  }

  const [{ purgeCapable }] = await su.prisma.$queryRaw<{ purgeCapable: boolean }[]>`
    SELECT
      has_function_privilege(current_user, 'public.tenant_claim_events_purge_for_tenant(uuid)', 'EXECUTE')
      AND has_table_privilege(current_user, 'public.tenant_claim_events', 'DELETE') AS "purgeCapable"
  `;
  if (!purgeCapable) {
    throw new Error(
      "[db-integration] the role connected via MIGRATION_DATABASE_URL cannot EXECUTE " +
        "tenant_claim_events_purge_for_tenant(uuid) or lacks DELETE on tenant_claim_events. " +
        "Point MIGRATION_DATABASE_URL at a role with both (passwd_user in dev).",
    );
  }

  // Every id createTenant() hands out, minus the ones deleteTestData() has
  // already removed. A test that throws before its trailing cleanup line
  // leaks its tenant onto the shared dev database, so cleanup() sweeps
  // whatever is left here rather than relying on each test's discipline.
  const outstandingTenantIds = new Set<string>();

  async function createTenant(): Promise<string> {
    const id = randomUUID();
    const slug = `test-${id.replace(/-/g, "").slice(0, 16)}`;
    await su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO tenants (id, name, slug, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, now(), now())`,
        id,
        `test-tenant-${id.slice(0, 8)}`,
        slug,
      );
    });
    outstandingTenantIds.add(id);
    return id;
  }

  function trackTenant(tenantId: string): void {
    // The sentinel is the one tenant id this sweep must never receive. Every
    // other id here is disposable; `__system__` is the FK target that makes an
    // unattributable audit emit writable at all (src/lib/audit/audit.ts,
    // resolveTenantId), so `deleteTestData`'s terminal `DELETE FROM tenants`
    // would take the encoding down for every working copy sharing this
    // database. Refused here rather than filtered inside the sweep, because a
    // test that reaches this line has already decided to hand the sentinel to
    // teardown and should be told so, not silently ignored.
    if (tenantId === SYSTEM_TENANT_ID) {
      throw new Error(
        "[db-integration] trackTenant refuses the sentinel tenant: cleanup() would " +
          "DELETE the row that every unattributable audit emit FKs to. Reclaim rows " +
          "written under it by a per-run marker (a targetId this test generated), " +
          "never by tenant_id alone.",
      );
    }
    outstandingTenantIds.add(tenantId);
  }

  async function createUser(tenantId: string): Promise<string> {
    const id = randomUUID();
    await su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO users (id, tenant_id, email, name, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, now(), now())`,
        id,
        tenantId,
        `test-${id.slice(0, 8)}@example.com`,
        `Test User ${id.slice(0, 8)}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'OWNER', now(), now())`,
        randomUUID(),
        tenantId,
        id,
      );
    });
    return id;
  }

  async function deleteTestData(tenantId: string): Promise<void> {
    await withCleanupConflictRetry(() => su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      // FK-safe deletion order
      await tx.$executeRawUnsafe(
        `DELETE FROM webhook_deliveries WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_deliveries WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_delivery_targets WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      // audit_outbox BEFORE audit_logs, deliberately. The live
      // audit-outbox-worker claims PENDING rows and then inserts the
      // corresponding audit_logs row; audit_logs_tenant_id_fkey is RESTRICT,
      // so a claim that lands after the audit_logs delete re-creates a child
      // row and the terminal `DELETE FROM tenants` below fails. Draining the
      // outbox first closes that window for every caller: the UPDATE locks
      // this tenant's rows (claimBatch uses FOR UPDATE SKIP LOCKED, so it
      // skips them) and the DELETE removes them before commit, while
      // anything the worker inserted earlier is still caught by the
      // audit_logs delete that now follows.
      //
      // The before-delete trigger blocks DELETE of PENDING/PROCESSING rows,
      // so first move them to FAILED (which the trigger allows).
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus"
         WHERE tenant_id = $1::uuid AND status IN ('PENDING', 'PROCESSING')`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_outbox WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      // MCP / delegation cleanup (FK-safe order)
      await tx.$executeRawUnsafe(
        `DELETE FROM delegation_sessions WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM mcp_refresh_tokens WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM mcp_access_tokens WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM mcp_authorization_codes WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM mcp_clients WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM service_account_tokens WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM service_accounts WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      // Team-vault cleanup (FK-safe order: history → entries → keys → members → teams)
      await tx.$executeRawUnsafe(
        `DELETE FROM team_password_entry_histories WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM team_password_entries WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM team_member_keys WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM team_members WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      // Webhook config tables FK to teams/tenants — delete before teams.
      await tx.$executeRawUnsafe(
        `DELETE FROM team_webhooks WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM tenant_webhooks WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM teams WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      // Personal-vault cleanup (FK-safe order: history → entries)
      await tx.$executeRawUnsafe(
        `DELETE FROM password_entry_histories WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM password_entries WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM tenant_members WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM users WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      // `tenants` LAST, then the tenant_claim_events purge — deliberately
      // reordered from "purge, then delete tenants" (20260731170000). A
      // `tenant_claims` row FKs to `tenants` with ON DELETE CASCADE, and a
      // BEFORE DELETE trigger on `tenant_claims` (the same migration) now
      // appends a `deregister` event for every row that cascade removes. A
      // purge run BEFORE this DELETE cannot see that event — it does not
      // exist yet — so it would leave a fresh, permanently undeletable row
      // on the shared dev database every time this context's tenant carried
      // a tenant_claims row. Purging AFTER catches it: the trigger's INSERT
      // and the cascade DELETE are in the same statement, so by the time
      // this DELETE returns the deregister row already exists, naming this
      // tenantId, and the purge call below reaches it exactly as it reaches
      // every other row naming this tenant.
      await tx.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = $1::uuid`,
        tenantId,
      );
      // tenant_claim_events (C1, SC11/#743) has no tenant_id column and no
      // FKs — it names a tenant only through old_tenant_id/new_tenant_id,
      // and a bare DELETE is blocked by the append-only trigger. The purge
      // routine is the one sanctioned escape (see the migration for why),
      // and I5's CHECK makes it total: every row names at least one tenant,
      // so purging both sides of every tenant this context ever creates
      // reaches every row this suite could have written, including the
      // deregister row the DELETE above may just have produced.
      try {
        await tx.$executeRawUnsafe(
          `SELECT tenant_claim_events_purge_for_tenant($1::uuid)`,
          tenantId,
        );
      } catch (e) {
        // Tagged distinctly from every other statement in this transaction
        // (round: C1 testing strategy). Every other row here is an ordinary
        // DELETE that a future FK fix can retry; a tenant_claim_events row
        // left behind by a failed purge is UNDELETABLE by anything short of
        // this same routine, so sweepLeakedTenants() must not fold this
        // into its best-effort "reported, not thrown" path below. Tagged by
        // class (TenantClaimEventsPurgeError), not by message text — a
        // reworded message must not silently degrade the sweep's abort into
        // warn-and-continue (QA-3a).
        throw new TenantClaimEventsPurgeError(
          `tenant_claim_events purge failed for tenant ${tenantId} (undeletable rows may remain): ` +
            `${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    }));
    // Only after the tx commits: a delete that threw leaves the tenant for
    // the cleanup() sweep. Ids this context never handed out (tenants a test
    // inserted itself) are simply not members, so this is a no-op for them.
    outstandingTenantIds.delete(tenantId);
  }

  /**
   * Delete every tenant this context was told about — createTenant()'s own
   * ids plus anything trackTenant() registered — that no deleteTestData() call
   * removed. Idempotent (each id is dropped once its delete commits, and
   * deleteTestData is scoped to a single id) and incapable of touching a
   * tenant no test in this file named, which matters because the dev database
   * is shared between working copies.
   *
   * Failures are reported rather than thrown: the sweep only has work to do
   * when a test already failed, and turning that into a second failure in
   * afterAll would bury the first. The ids are printed so a leak that the
   * sweep cannot resolve is still actionable.
   *
   * The one exception is `sweepLeakedTenants` below, for a
   * TenantClaimEventsPurgeError.
   */
  async function sweepOutstandingTenants(): Promise<void> {
    await sweepLeakedTenants([...outstandingTenantIds], deleteTestData);
  }

  // A sweep failure (TenantClaimEventsPurgeError, re-thrown after the loop
  // finishes and the report is printed — see sweepLeakedTenants) must not
  // skip disconnecting every pool: a leaked pg.Pool keeps the forked
  // vitest worker process alive (QA-3c).
  async function disconnectAll(): Promise<void> {
    await Promise.all([
      su.prisma.$disconnect().then(() => su.pool.end()),
      app.prisma.$disconnect().then(() => app.pool.end()),
      worker.prisma.$disconnect().then(() => worker.pool.end()),
      retentionWorker.prisma.$disconnect().then(() => retentionWorker.pool.end()),
    ]);
  }

  async function cleanup(): Promise<void> {
    await runCleanupSweep(sweepOutstandingTenants, disconnectAll);
  }

  return {
    su,
    app,
    worker,
    retentionWorker,
    createTenant,
    trackTenant,
    createUser,
    deleteTestData,
    cleanup,
  };
}

// ─── Deferred barrier for concurrency tests ─────────────────────

export class Deferred<T = void> {
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;
  promise: Promise<T>;

  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

// ─── Vault-user seed helper ──────────────────────────────────────

/**
 * Seed a minimal vault-enabled user (sets encrypted_secret_key, key_version,
 * vault_setup_at, account_salt, etc.) directly via the superuser pool so
 * tests do not need a real passphrase-setup flow.
 *
 * vault_setup_at + account_salt are read by the rotation tuple-CAS
 * (applyVaultRotation's pre-write FOR UPDATE check), so both must be set
 * here and returned for callers to pass as the CAS snapshot.
 */
export async function seedVaultUser(
  ctx: TestContext,
  tenantId: string,
): Promise<{ userId: string; keyVersion: number; vaultSetupAt: Date; accountSalt: string }> {
  const userId = await ctx.createUser(tenantId);
  const keyVersion = 1;
  const accountSalt = randomBytes(16).toString("hex");
  const vaultSetupAt = new Date();

  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `UPDATE users SET
         encrypted_secret_key = $2,
         secret_key_iv = $3,
         secret_key_auth_tag = $4,
         account_salt = $5,
         master_password_server_hash = $6,
         master_password_server_salt = $7,
         key_version = $8,
         encrypted_ecdh_private_key = $9,
         ecdh_private_key_iv = $10,
         ecdh_private_key_auth_tag = $11,
         vault_setup_at = $12
       WHERE id = $1::uuid`,
      userId,
      "placeholder-esk",
      randomBytes(12).toString("hex"),
      randomBytes(16).toString("hex"),
      accountSalt,
      randomBytes(32).toString("hex"),
      randomBytes(32).toString("hex"),
      keyVersion,
      "placeholder-ecdh",
      randomBytes(12).toString("hex"),
      randomBytes(16).toString("hex"),
      vaultSetupAt,
    );
  });

  return { userId, keyVersion, vaultSetupAt, accountSalt };
}

// ─── Statistical concurrency primitive ──────────────────────────

/**
 * Run two operations in parallel against distinct Prisma clients
 * (= distinct pg.Pool connections), pre-warming both connections so the
 * race window is as tight as `Promise.all` allows.
 *
 * The pg_advisory_lock barrier pattern was considered (plan §11.2 option
 * (b)) but option (a) — the statistical loop — is what callers should
 * wrap this in: 50 iterations is sufficient to flush ordering
 * nondeterminism on a connection-pooled real DB without adding a new
 * concurrency primitive to the repo (no existing precedent).
 */
export async function raceTwoClients<A, B>(
  clientA: PrismaClient,
  clientB: PrismaClient,
  opA: (c: PrismaClient) => Promise<A>,
  opB: (c: PrismaClient) => Promise<B>,
): Promise<[A, B]> {
  // Pre-warm both pooled connections so neither path pays a connection-
  // setup cost during the race.
  await Promise.all([
    clientA.$executeRawUnsafe(`SELECT 1`),
    clientB.$executeRawUnsafe(`SELECT 1`),
  ]);
  return Promise.all([opA(clientA), opB(clientB)]) as Promise<[A, B]>;
}
