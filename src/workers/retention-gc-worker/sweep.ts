/**
 * Sweep logic for the retention-GC worker.
 *
 * Three exported functions:
 *   sweepExpiryEntry  — batch-bounded DELETE for EXPIRY entries
 *   sweepAuditLogs    — per-tenant audit log purge via SECURITY DEFINER fn
 *   sweepOnce         — orchestrates one full registry sweep + heartbeat audit
 *
 * Each EXPIRY entry runs in its own transaction. The PER_TENANT_FN entry runs
 * in its own transaction. The heartbeat runs in a final separate transaction
 * after all per-entry counts are collected (INV-C4a). A per-entry failure is
 * caught, logged {table, code} (the authoritative error record — F7), and the
 * sweep continues (INV-C4b).
 */

import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { getLogger } from "@/lib/logger";
import {
  AUDIT_SCOPE,
  AUDIT_ACTION,
  ACTOR_TYPE,
  AUDIT_METADATA_KEY,
} from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID, SYSTEM_TENANT_ID } from "@/lib/constants/app";
import type { AuditOutboxPayload } from "@/lib/audit/audit-outbox";
import { MS_PER_DAY } from "@/lib/constants/time";
import { AUDIT_LOG_RETENTION_MIN } from "@/lib/validations/common";
import { assertIdentifier, renderPredicate } from "./predicate";
import {
  RETENTION_REGISTRY,
  type ExpiryEntry,
  type GuardedExpiryEntry,
  type GuardName,
  type AuditProvenanceEntry,
  type PerTenantFnEntry,
  type PerTenantTrashEntry,
  type PerTenantAgeEntry,
} from "./registry";
import { USER_AGENT_MAX_LENGTH } from "@/lib/validations/common.server";
import {
  collectEntryAttachmentRefs,
  deleteAttachmentBlobs,
  type AttachmentBlobRef,
} from "@/lib/blob-store/cleanup";

/**
 * Fixed "no live dependents" guard SQL fragments, keyed by GuardName.
 *
 * These are compile-time literals — NOT registry data — so the NOT EXISTS
 * subqueries (which reference fixed child table/column names) never widen the
 * S1 SQL-injection containment boundary. Each fragment is AND-appended to the
 * guarded delete's WHERE clause; `<parent>` is the placeholder for the parent
 * table name (allowlist-validated) so the correlation predicate binds correctly.
 */
const GUARD_SQL: Record<GuardName, (parent: string) => string> = {
  // mcp_access_tokens: hold the delete until no live refresh token or delegation
  // session references this access token. The FK CASCADE then removes the dead
  // children. revoked tokens/sessions do NOT count as live (a fully-rotated-away
  // or revoked family GCs correctly).
  MCP_TOKEN_FAMILY_DEAD: (parent) =>
    `AND NOT EXISTS (
       SELECT 1 FROM mcp_refresh_tokens r
       WHERE r.access_token_id = ${parent}.id
         AND r.revoked_at IS NULL AND r.expires_at > now()
     )
     AND NOT EXISTS (
       SELECT 1 FROM delegation_sessions d
       WHERE d.mcp_token_id = ${parent}.id
         AND d.revoked_at IS NULL AND d.expires_at > now()
     )`,
  // emergency_access_grants: token_expires_at is the 7-day INVITATION window, NOT
  // a death signal — an ACCEPTED/IDLE/ACTIVATED grant stays live past it. A grant
  // is dead only when terminal (REVOKED/REJECTED) or a never-accepted expired
  // invite (PENDING + token_expires_at past). STALE/IDLE are recoverable, NOT
  // included. Status literals are compile-time constants here (S1-safe).
  EMERGENCY_GRANT_DEAD: (parent) =>
    `AND (
       ${parent}.status IN ('REVOKED', 'REJECTED')
       OR (${parent}.status = 'PENDING' AND ${parent}.token_expires_at < now())
     )`,
};

// Re-export EmitFn and enqueueAuditInWorkerTx so integration tests can target them.
export type EmitFn = (
  tx: Prisma.TransactionClient,
  tenantId: string,
  payload: AuditOutboxPayload,
) => Promise<void>;

export interface SweepOpts {
  intervalMs: number;
  emitHeartbeatAudit: boolean;
  /**
   * Optional override for the audit-emit step in sweepOnce's heartbeat tx.
   * Used only in integration tests to simulate heartbeat-tx failures (C4 idempotency test).
   * Production callers omit this; sweepOnce defaults to enqueueAuditInWorkerTx.
   */
  _emitFn?: EmitFn;
}

/**
 * Inline audit enqueue — mirrors enqueueAuditInTx from @/lib/audit/audit-outbox
 * but inlined here to avoid the transitive import of @/lib/prisma (the app
 * singleton), which would throw at module load time when DATABASE_URL is unset.
 * Behaviour is identical: verifies bypass_rls GUC, checks tenant existence,
 * then writes to audit_outbox within the caller's transaction.
 *
 * Exported so integration tests can stub it via the _emitFn override.
 */
export async function enqueueAuditInWorkerTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  payload: AuditOutboxPayload,
): Promise<void> {
  const [ctx] = await tx.$queryRaw<{ bypass_rls: string; tenant_id: string }[]>`
    SELECT current_setting('app.bypass_rls', true) AS bypass_rls,
           current_setting('app.tenant_id', true)  AS tenant_id`;
  if (ctx.bypass_rls !== "on" && ctx.tenant_id !== tenantId) {
    throw new Error(
      `enqueueAuditInWorkerTx: called outside bypass_rls scope; ` +
        `bypass_rls=${ctx.bypass_rls}, tenant_id=${ctx.tenant_id}, expected=${tenantId}`,
    );
  }
  const [tenantExists] = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM tenants WHERE id = ${tenantId}::uuid) AS ok`;
  if (!tenantExists?.ok) {
    throw new Error(
      `enqueueAuditInWorkerTx: tenantId ${tenantId} does not exist`,
    );
  }
  await tx.auditOutbox.create({
    data: {
      tenantId,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
  });
}

/**
 * Delete up to `batchSize` expired rows for one EXPIRY registry entry.
 *
 * Security:
 * - Identifiers (table, cutoffColumn, keyColumns) are validated at worker boot
 *   via assertIdentifier in createWorker; called here defensively too.
 * - bypass_rls GUC is set in-tx for every globalDelete entry (INV-C2b).
 * - DELETE is batch-bounded via (keys) IN (SELECT keys ... LIMIT $1) — the
 *   ONLY parameter bound is batchSize; all other tokens come from the registry
 *   (literal strings, allowlist-validated), never from runtime input.
 *
 * @returns Number of rows deleted.
 */
export async function sweepExpiryEntry(
  tx: Prisma.TransactionClient,
  entry: ExpiryEntry,
  batchSize: number,
): Promise<number> {
  // Defensive identifier validation at sweep time (boot validation is primary).
  assertIdentifier(entry.table);
  assertIdentifier(entry.cutoffColumn);
  for (const col of entry.keyColumns) {
    assertIdentifier(col);
  }

  if (entry.globalDelete) {
    // Set bypass_rls GUC to span all tenants under the existing RLS policies.
    // Mirror dcr-cleanup-worker.ts:95.
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
  }

  // Build the predicate fragment (may be empty string if no predicate).
  const predicateSql =
    entry.predicate && entry.predicate.length > 0
      ? ` AND ${renderPredicate(entry.predicate)}`
      : "";

  // Row-value (keys) IN (SELECT keys ...) form works for both single-column
  // ("id") and composite ("identifier", "token") key sets.
  const keyList = entry.keyColumns.join(", ");
  // raw-sql-ident: registry identifiers validated by validateRegistry() at boot; only closed-set table/column names, never user input
  const sql = `DELETE FROM ${entry.table}
    WHERE (${keyList}) IN (
      SELECT ${keyList} FROM ${entry.table}
      WHERE ${entry.cutoffColumn} < now()${predicateSql}
      LIMIT $1
    )`;

  return tx.$executeRawUnsafe<number>(sql, batchSize);
}

/**
 * Batch-bounded DELETE for an EXPIRY_GUARDED entry — an expiry delete on a parent
 * table gated by a code-defined "no live dependents" guard (GUARD_SQL[entry.guard]).
 *
 * Same (keys) IN (SELECT keys WHERE cutoff < now() AND <guard> LIMIT $1) shape as
 * sweepExpiryEntry. The guard's NOT EXISTS subqueries are compile-time literals
 * keyed by the closed GuardName enum — never registry data (S1). bypass_rls is set
 * (globalDelete) so the parent delete AND the FK-cascade to child rows span all
 * tenants under the existing RLS policies. batchSize is the only bound param.
 */
export async function sweepGuardedExpiryEntry(
  tx: Prisma.TransactionClient,
  entry: GuardedExpiryEntry,
  batchSize: number,
): Promise<number> {
  assertIdentifier(entry.table);
  assertIdentifier(entry.cutoffColumn);
  for (const col of entry.keyColumns) {
    assertIdentifier(col);
  }

  if (entry.globalDelete) {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
  }

  const guardSql = GUARD_SQL[entry.guard](entry.table);
  const keyList = entry.keyColumns.join(", ");
  // raw-sql-ident: registry identifiers validated by validateRegistry() at boot; only closed-set table/column names, never user input
  const sql = `DELETE FROM ${entry.table}
    WHERE (${keyList}) IN (
      SELECT ${keyList} FROM ${entry.table}
      WHERE ${entry.cutoffColumn} < now()
      ${guardSql}
      LIMIT $1
    )`;

  return tx.$executeRawUnsafe<number>(sql, batchSize);
}

/**
 * Delete-then-audit for an EXPIRY_AUDIT_PROVENANCE entry (SC4).
 *
 * For credential tables whose rows carry forensic provenance (lastUsedIp/At,
 * actor binding), this deletes each expired row FIRST — batch-bound via the
 * same (keys) IN (SELECT keys ... LIMIT $1) shape as sweepExpiryEntry, with
 * the provenance columns added to the RETURNING projection — then emits the
 * audit event from the RETURNING rows, all in the same tx. Emitting from
 * rows the DELETE actually removed (rather than a prior SELECT) is what
 * makes this race-safe: two concurrent sweep instances can no longer both
 * capture the same row and both emit an audit for it (A2) — Postgres row
 * locking on the DELETE ensures each row is returned to exactly one racer.
 * Per row the audit is emitted under the row's OWN tenant_id, so it lands in
 * the owning tenant's audit log.
 *
 * No explicit row lock (FOR UPDATE) is needed before the DELETE: the DELETE
 * itself takes the row lock. A FOR UPDATE lock would additionally need
 * UPDATE privilege, which the GC role deliberately lacks.
 *
 * When entry.retentionDays is set (M2), the cutoff is pushed back by that
 * many days (`cutoffColumn < now() - retentionDays days`) instead of the
 * plain `< now()` — giving a status-flip interim on the same table (e.g.
 * access_requests' PENDING -> EXPIRED sweep) a visibility window before this
 * delete purges the row. retentionDays is bound as a parameter, not
 * interpolated — it is a value, not an identifier.
 *
 * @returns Rows deleted (and audited) this batch.
 */
export async function sweepAuditProvenanceEntry(
  tx: Prisma.TransactionClient,
  entry: AuditProvenanceEntry,
  batchSize: number,
): Promise<number> {
  assertIdentifier(entry.table);
  assertIdentifier(entry.cutoffColumn);
  for (const col of entry.provenanceColumns) {
    assertIdentifier(col);
  }

  if (entry.globalDelete) {
    // bypass_purpose/tenant_id GUCs are intentionally not set here (unlike
    // audit-outbox-worker's setBypassRlsGucs) — they are observability-only
    // today (not read by any RLS policy or trigger). TODO(route-policy-sql-security):
    // extract a shared setBypassRlsGucsOnTx helper and set them consistently.
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
  }

  // Optional "this row is dead" guard (SC6b) — a compile-time-literal SQL fragment
  // from GUARD_SQL, appended to the WHERE. Used when cutoffColumn alone cannot
  // express GC-eligibility (e.g. emergency_access_grants).
  const guardSql = entry.guard ? ` ${GUARD_SQL[entry.guard](entry.table)}` : "";
  const projection = ["id", ...entry.provenanceColumns].join(", ");
  // Optional grace window (M2): when retentionDays is set, push the cutoff
  // back by that many days so a status-flip interim (e.g. access_requests'
  // PENDING -> EXPIRED sweep, sharing this cutoff column) stays visible before
  // this hard-delete purges it. The integer is bound as $2 — never
  // interpolated — so it stays a value, not part of the SQL text.
  const cutoffSql = entry.retentionDays
    ? `${entry.cutoffColumn} < now() - ($2 || ' days')::interval`
    : `${entry.cutoffColumn} < now()`;
  const params: unknown[] = entry.retentionDays
    ? [batchSize, entry.retentionDays]
    : [batchSize];
  // Batch-bounded (id) IN (SELECT id ... LIMIT $1) DELETE, RETURNING the
  // provenance projection so the audit can be emitted from what was actually
  // deleted — mirrors sweepExpiryEntry's shape, extended with RETURNING.
  const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
    // raw-sql-ident: registry identifiers validated by validateRegistry() at boot; only closed-set table/column names, never user input
    `DELETE FROM ${entry.table}
       WHERE (id) IN (
         SELECT id FROM ${entry.table}
         WHERE ${cutoffSql}${guardSql}
         LIMIT $1
       )
       RETURNING ${projection}`,
    ...params,
  );

  if (rows.length === 0) return 0;

  for (const row of rows) {
    const tenantId = String(row["tenant_id"]);
    const provenance: Record<string, unknown> = { table: entry.table };
    for (const col of entry.provenanceColumns) {
      const value = row[col] ?? null;
      // Defense-in-depth: cap the free-text user-agent in metadata too (the
      // source column is @db.Text; ingest caps it, but don't rely on that here).
      provenance[col] =
        col === "last_used_user_agent" && typeof value === "string"
          ? value.slice(0, USER_AGENT_MAX_LENGTH)
          : value;
    }
    // Emit AFTER delete, from the RETURNING row, in the same tx — the row is
    // already gone, so a racing instance cannot have captured (and will emit
    // an audit for) the same row (A2 fix).
    await enqueueAuditInWorkerTx(tx, tenantId, {
      scope: AUDIT_SCOPE.TENANT,
      action: AUDIT_ACTION[entry.auditAction],
      userId: SYSTEM_ACTOR_ID,
      actorType: ACTOR_TYPE.SYSTEM,
      serviceAccountId: null,
      teamId: null,
      targetType: entry.table,
      targetId: String(row["id"]),
      metadata: provenance,
      // Surface the credential's last-used network provenance in the dedicated
      // audit columns when the table carries them (extension_tokens).
      ip: row["last_used_ip"] != null ? String(row["last_used_ip"]) : null,
      userAgent:
        row["last_used_user_agent"] != null
          ? String(row["last_used_user_agent"]).slice(0, USER_AGENT_MAX_LENGTH)
          : null,
    });
  }

  return rows.length;
}

/**
 * Delete expired audit_logs rows for every tenant with a non-null retention setting.
 *
 * - Enumerates only tenants with auditLogRetentionDays IS NOT NULL.
 * - Clamps each tenant's retention to max(retention, AUDIT_LOG_RETENTION_MIN) (S4 floor).
 * - Deletion is routed through audit_log_purge(uuid, timestamptz), a SECURITY
 *   DEFINER function — the worker role has no direct DELETE grant on audit_logs (S5/F5).
 * - Runs under bypass_rls to read tenants across all tenant-id contexts (INV-C3c).
 *
 * @returns Total rows deleted across all enumerated tenants.
 */
export async function sweepAuditLogs(
  tx: Prisma.TransactionClient,
  _entry: PerTenantFnEntry,
): Promise<number> {
  // bypass_rls required to enumerate tenants (no app.tenant_id set in the worker).
  await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;

  // Enumerate only tenants that have explicit retention configured.
  // NULL → no auto-deletion (FR4).
  const tenants = await tx.tenant.findMany({
    where: { auditLogRetentionDays: { not: null } },
    select: { id: true, auditLogRetentionDays: true },
  });

  let total = 0;
  for (const tenant of tenants) {
    const retention = tenant.auditLogRetentionDays!;
    // Clamp to the system minimum floor so a tenant cannot shorten retention below 30d.
    const effectiveDays = Math.max(retention, AUDIT_LOG_RETENTION_MIN);
    const cutoff = new Date(Date.now() - effectiveDays * MS_PER_DAY);

    const rows = await tx.$queryRaw<Array<{ rows_deleted: number }>>`
      SELECT audit_log_purge(${tenant.id}::uuid, ${cutoff}::timestamptz) AS rows_deleted
    `;
    total += rows[0]?.rows_deleted ?? 0;
  }

  return total;
}

/**
 * Plain per-tenant age-based DELETE (SC3): trims rows older than each tenant's
 * configured retention. Unlike sweepAuditLogs (definer fn for immutability),
 * these tables (entry history) are trimmed with a direct batch-bounded DELETE.
 *
 * Takes a `tx` (dispatched via workerPrisma.$transaction, like sweepAuditLogs).
 * Sets bypass_rls first; enumerates tenants with the retention column NOT NULL;
 * per tenant deletes `<table>` rows where `<cutoffColumn> < now() - retention`.
 * Emits a per-tenant audit (entry.auditAction) when a tenant has rows trimmed.
 *
 * @returns Total rows deleted across all enumerated tenants.
 */
export async function sweepPerTenantAge(
  tx: Prisma.TransactionClient,
  entry: PerTenantAgeEntry,
  batchSize: number,
): Promise<number> {
  assertIdentifier(entry.table);
  assertIdentifier(entry.cutoffColumn);

  await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;

  // Enumerate only tenants with the retention column configured (NULL → skip).
  // The retention column is a dynamic (but closed-union) Prisma field name, so
  // type the rows explicitly — a computed `select` key defeats Prisma inference.
  const col = entry.tenantRetentionColumn;
  // A computed `select` key defeats Prisma's row-type inference (the return type
  // widens to a 50-model union), so narrow explicitly through `unknown`.
  const tenants = (await tx.tenant.findMany({
    where: { [col]: { not: null } },
    select: { id: true, [col]: true },
  })) as unknown as Array<{ id: string } & Record<typeof col, number | null>>;

  let total = 0;
  for (const tenant of tenants) {
    const retention = tenant[col] as number;
    const cutoff = new Date(Date.now() - retention * MS_PER_DAY);

    // Batch-bounded (id) IN (SELECT id ... LIMIT) — table/cutoffColumn are
    // allowlist-validated; tenant id, cutoff, batchSize are bound params.
    // raw-sql-ident: registry identifiers validated by validateRegistry() at boot; only closed-set table/column names, never user input
    const deleted = await tx.$executeRawUnsafe<number>(
      `DELETE FROM ${entry.table}
         WHERE (id) IN (
           SELECT id FROM ${entry.table}
           WHERE tenant_id = $1::uuid
             AND ${entry.cutoffColumn} < $2::timestamptz
           LIMIT $3
         )`,
      tenant.id,
      cutoff,
      batchSize,
    );

    if (deleted > 0) {
      await enqueueAuditInWorkerTx(tx, tenant.id, {
        scope: AUDIT_SCOPE.TENANT,
        action: AUDIT_ACTION[entry.auditAction],
        userId: SYSTEM_ACTOR_ID,
        actorType: ACTOR_TYPE.SYSTEM,
        serviceAccountId: null,
        teamId: null,
        targetType: entry.table,
        targetId: null,
        metadata: {
          table: entry.table,
          purgedCount: deleted,
          triggeredBy: "retention-gc-worker",
        },
        ip: null,
        userAgent: "retention-gc-worker",
      });
    }

    total += deleted;
  }

  return total;
}

/**
 * Auto-purge soft-deleted (trashed) vault entries past each tenant's configured
 * grace period (SC2). One PER_TENANT_TRASH entry per entry table.
 *
 * Per tenant, in its own transaction:
 *   1. set bypass_rls FIRST (entry tables AND attachments are RLS-enabled).
 *   2. SELECT trashed entry ids past `now() - trashRetentionDays days` (LIMIT
 *      batchSize). For team_password_entries also select team_id.
 *   3. Collect external blob refs BEFORE the cascade destroys the Attachment
 *      rows. For team scope the ids are grouped by team_id and
 *      collectEntryAttachmentRefs is called once per team group (F4) — its team
 *      scope takes a single teamId. Refs are [] on the DB backend.
 *   4. deleteMany the entries by id (cascade removes attachments/history/
 *      favorites/tag-links; SetNull on password_shares).
 *   5. Emit a per-tenant TRASH_RETENTION_PURGED audit (only if rows deleted).
 *
 * AFTER the tx commits, the collected external blobs are deleted best-effort
 * (deleteAttachmentBlobs uses Promise.allSettled) — mirrors empty-trash: a
 * failed external delete orphans an object but never leaves a dangling DB row.
 *
 * Unlike the other sweepers this takes workerPrisma (not a tx): the external
 * blob delete must run after the DB tx commits, so this owns its own
 * transactions.
 *
 * @returns Total entries deleted across all enumerated tenants.
 */
export async function sweepTrashEntry(
  workerPrisma: PrismaClient,
  entry: PerTenantTrashEntry,
  batchSize: number,
): Promise<number> {
  assertIdentifier(entry.table);

  // Enumerate only tenants with explicit trash retention configured (NULL → skip).
  const tenants = await workerPrisma.tenant.findMany({
    where: { trashRetentionDays: { not: null } },
    select: { id: true, trashRetentionDays: true },
  });

  let total = 0;
  for (const tenant of tenants) {
    const retention = tenant.trashRetentionDays!;
    const cutoff = new Date(Date.now() - retention * MS_PER_DAY);

    const { deletedCount, refs } = await workerPrisma.$transaction(
      async (tx) => {
        // bypass_rls FIRST — both entry tables and attachments are RLS-enabled.
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;

        // Select trashed entries past the cutoff. team scope also needs team_id
        // so the refs can be partitioned by team (F4).
        const rows =
          entry.scopeKind === "team"
            ? await tx.$queryRaw<Array<{ id: string; team_id: string }>>`
                SELECT id, team_id FROM team_password_entries
                WHERE tenant_id = ${tenant.id}::uuid
                  AND deleted_at IS NOT NULL
                  AND deleted_at < ${cutoff}
                LIMIT ${batchSize}`
            : await tx.$queryRaw<Array<{ id: string }>>`
                SELECT id FROM password_entries
                WHERE tenant_id = ${tenant.id}::uuid
                  AND deleted_at IS NOT NULL
                  AND deleted_at < ${cutoff}
                LIMIT ${batchSize}`;

        if (rows.length === 0) {
          return { deletedCount: 0, refs: [] as AttachmentBlobRef[] };
        }

        const ids = rows.map((r) => r.id);

        // Collect external blob refs BEFORE the cascade delete.
        const collected: AttachmentBlobRef[] = [];
        if (entry.scopeKind === "team") {
          // Group ids by team_id; one collectEntryAttachmentRefs call per team.
          const idsByTeam = new Map<string, string[]>();
          for (const row of rows as Array<{ id: string; team_id: string }>) {
            const list = idsByTeam.get(row.team_id) ?? [];
            list.push(row.id);
            idsByTeam.set(row.team_id, list);
          }
          for (const [teamId, teamEntryIds] of idsByTeam) {
            collected.push(
              ...(await collectEntryAttachmentRefs(tx, {
                kind: "team",
                teamId,
                entryIds: teamEntryIds,
              })),
            );
          }
          await tx.teamPasswordEntry.deleteMany({ where: { id: { in: ids } } });
        } else {
          collected.push(
            ...(await collectEntryAttachmentRefs(tx, {
              kind: "personal",
              entryIds: ids,
            })),
          );
          await tx.passwordEntry.deleteMany({ where: { id: { in: ids } } });
        }

        await enqueueAuditInWorkerTx(tx, tenant.id, {
          scope: AUDIT_SCOPE.TENANT,
          action: AUDIT_ACTION.TRASH_RETENTION_PURGED,
          userId: SYSTEM_ACTOR_ID,
          actorType: ACTOR_TYPE.SYSTEM,
          serviceAccountId: null,
          teamId: null,
          targetType: entry.table,
          targetId: null,
          metadata: { table: entry.table, purgedCount: ids.length },
          ip: null,
          userAgent: "retention-gc-worker",
        });

        return { deletedCount: ids.length, refs: collected };
      },
    );

    // Best-effort external blob delete AFTER the tx commits (mirrors empty-trash).
    await deleteAttachmentBlobs(refs);
    total += deletedCount;
  }

  return total;
}

/**
 * Flip PENDING access_requests past their expiry to EXPIRED (external-review
 * 2026-07 remediation, C7 / 残3). This is a status TRANSITION, not a delete —
 * the existing EXPIRY_AUDIT_PROVENANCE registry entry for access_requests
 * (registry.ts, cutoff = expires_at, retentionDays grace) still hard-deletes
 * the row later, but with a grace offset on the SAME cutoff column (M2) — so
 * the EXPIRED state is actually visible to the tenant UI for that window
 * before the eventual purge, instead of being hard-deleted in the same
 * sweepOnce cycle it was flipped in. The day count lives ONLY on the
 * registry entry (single source of truth).
 *
 * State-machine cross-reference: PENDING -> EXPIRED by actor SYSTEM is the
 * MATRIX entry at src/lib/access-request/access-request-state.ts (MATRIX
 * [PENDING][EXPIRED] = [AR_ACTOR.SYSTEM]); access-request-state.test.ts pins
 * it green, and the SQL/MATRIX parity test below fails if that entry is ever
 * removed while this SQL stays.
 *
 * Raw SQL instead of bulkTransition(): bulkTransition's bypass-mode guard
 * (hasScopeUnderBypass) requires a tenantId predicate, which a global,
 * cross-tenant sweep does not have — widening the guard to carve out a
 * SYSTEM-sweep exception was rejected (plan C7) as risking route-path callers
 * inheriting the relaxed guard. The UPDATE is a static template (no
 * interpolated values — injection-free by construction) and idempotent
 * (re-running finds fewer or zero newly-expired rows). Batch-bounded via the
 * `(id) IN (SELECT id ... LIMIT $1)` key-set shape used by every other sweep
 * in this file, so one cycle never flips an unbounded number of rows.
 * CAS by construction: the outer WHERE ALSO repeats `status = 'PENDING'`
 * (AND-appended after the key-set-IN clause, not just inside the inner
 * SELECT), so under READ COMMITTED's EvalPlanQual re-check a row concurrently
 * approved between the SELECT and the UPDATE is re-evaluated against the
 * outer predicate and skipped — it cannot flip APPROVED back to EXPIRED. The
 * key-set-IN clause is kept WHERE-leading (rather than status-leading) so it
 * stays structurally recognizable to the static sweepBounds check in
 * worker-policy-manifest.test.ts, which requires the batch-limiting
 * `WHERE <keys> IN (SELECT <keys> ... LIMIT n)` shape to be contiguous.
 *
 * Runs under the worker's bypass_rls GUC (RLS-enabled table, NOBYPASSRLS
 * role) — same pattern as sweepExpiryEntry's globalDelete branch. Requires
 * the migration 20260722000100 GRANT UPDATE (status) ON access_requests.
 *
 * @returns Number of rows flipped to EXPIRED this batch.
 */
export async function sweepExpiredAccessRequests(
  tx: Prisma.TransactionClient,
  batchSize: number,
): Promise<number> {
  await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;

  return tx.$executeRawUnsafe<number>(
    `UPDATE access_requests
       SET status = 'EXPIRED'
       WHERE (id) IN (
         SELECT id FROM access_requests
         WHERE status = 'PENDING' AND expires_at < now()
         LIMIT $1
       )
       AND status = 'PENDING'`,
    batchSize,
  );
}

/**
 * Run one full sweep across the RETENTION_REGISTRY.
 *
 * Each EXPIRY entry runs in its own $transaction (INV-C4a). A per-entry error
 * is caught, logged {table, code} (the authoritative error record — F7), and
 * the sweep continues (INV-C4b). After collecting all counts, a final separate
 * transaction emits one heartbeat audit row summarising the sweep.
 *
 * The heartbeat tx is NOT atomic with the delete txs (deliberate C4 deviation):
 * per-entry isolation requires separate txs, so atomicity is impossible. The
 * per-entry structured log line is the durable authoritative record; the
 * heartbeat is best-effort (same contract as logAuditAsync).
 *
 * @returns A map of table name → rows deleted (or -1 on per-entry error).
 */
export async function sweepOnce(
  workerPrisma: PrismaClient,
  batchSize: number,
  opts: SweepOpts,
): Promise<Record<string, number>> {
  const log = getLogger();
  const counts: Record<string, number> = {};

  // PENDING -> EXPIRED status sweep runs BEFORE registry processing (C7):
  // a per-entry registry failure below must not block this cheap, independent
  // status flip. Isolated in its own try/catch — same per-entry error
  // isolation contract as the registry loop (INV-C4b).
  try {
    const expiredCount = await workerPrisma.$transaction((tx) =>
      sweepExpiredAccessRequests(tx, batchSize),
    );
    if (expiredCount > 0) {
      log.info({ count: expiredCount }, "retention-gc.access_requests_expired");
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
    log.error({ table: "access_requests", code }, "retention-gc.entry_failed");
  }

  for (const entry of RETENTION_REGISTRY) {
    const tableName = entry.table;
    try {
      // Explicit per-kind dispatch (F1) — no elimination-else, so a future kind
      // cannot silently misroute into the wrong branch.
      if (entry.kind === "EXPIRY") {
        counts[tableName] = await workerPrisma.$transaction(async (tx) =>
          sweepExpiryEntry(tx, entry, batchSize),
        );
      } else if (entry.kind === "EXPIRY_GUARDED") {
        counts[tableName] = await workerPrisma.$transaction(async (tx) =>
          sweepGuardedExpiryEntry(tx, entry, batchSize),
        );
      } else if (entry.kind === "EXPIRY_AUDIT_PROVENANCE") {
        counts[tableName] = await workerPrisma.$transaction(async (tx) =>
          sweepAuditProvenanceEntry(tx, entry, batchSize),
        );
      } else if (entry.kind === "PER_TENANT_FN") {
        counts[tableName] = await workerPrisma.$transaction(async (tx) =>
          sweepAuditLogs(tx, entry),
        );
      } else if (entry.kind === "PER_TENANT_TRASH") {
        // Unlike other kinds, call sweepTrashEntry with workerPrisma DIRECTLY
        // (no outer $transaction): it owns its own per-tenant transactions
        // because the external blob delete must run after each DB tx commits.
        counts[tableName] = await sweepTrashEntry(workerPrisma, entry, batchSize);
      } else if (entry.kind === "PER_TENANT_AGE") {
        counts[tableName] = await workerPrisma.$transaction(async (tx) =>
          sweepPerTenantAge(tx, entry, batchSize),
        );
      }
    } catch (err) {
      // Per-entry error isolation (INV-C4b): log {table, code} — authoritative error record (F7).
      // Never log err.message or the generated SQL (S6).
      const code =
        (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
      log.error({ table: tableName, code }, "retention-gc.entry_failed");
      counts[tableName] = -1;
    }
  }

  // Emit a heartbeat audit row if any rows were deleted, or if always-on heartbeat is set.
  const anyDeleted = Object.values(counts).some((n) => n > 0);
  if (anyDeleted || opts.emitHeartbeatAudit) {
    const totalDeleted = Object.values(counts)
      .filter((n) => n > 0)
      .reduce((sum, n) => sum + n, 0);

    try {
      const emitFn = opts._emitFn ?? enqueueAuditInWorkerTx;
      await workerPrisma.$transaction(async (tx) => {
        // Heartbeat runs in its own bypass_rls context (SYSTEM_TENANT_ID exists
        // by design; INV-C3c — the anchor is system-scoped, not subject to
        // per-tenant purge).
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await emitFn(tx, SYSTEM_TENANT_ID, {
          scope: AUDIT_SCOPE.TENANT,
          action: AUDIT_ACTION.RETENTION_GC_SWEEP,
          userId: SYSTEM_ACTOR_ID,
          actorType: ACTOR_TYPE.SYSTEM,
          serviceAccountId: null,
          teamId: null,
          targetType: null,
          targetId: null,
          metadata: {
            [AUDIT_METADATA_KEY.PURGED_COUNT]: totalDeleted,
            perTable: counts,
            sweepIntervalMs: opts.intervalMs,
          },
          ip: null,
          userAgent: "retention-gc-worker",
        });
      });
    } catch (err) {
      // Heartbeat failure is non-fatal. The per-entry log lines are the
      // authoritative record (INV-C4b). Log {code} only (S6).
      const code =
        (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
      log.error({ code }, "retention-gc.heartbeat_failed");
    }
  }

  return counts;
}
