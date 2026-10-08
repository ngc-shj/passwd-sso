/**
 * Unit-level SQL-shape assertions for sweepExpiryEntry (C2 acceptance / RT7).
 *
 * The integration tests prove BEHAVIOR (correct rows deleted on a live DB).
 * This unit test pins the generated SQL TEXT and parameter binding — the
 * string-building surface (keyList join, predicate concatenation, the
 * `WITH picked AS MATERIALIZED (... LIMIT $1) ... (keys) IN (SELECT keys FROM
 * picked)` shape, C1) — so a regression that double-binds, binds an extra
 * param, or leaks a non-literal token into the SQL is caught even when the
 * row math coincidentally still matches.
 *
 * Explicit string assertions, NOT snapshots (the repo has no snapshot infra
 * and snapshots drift unread).
 */

import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { sweepExpiryEntry, sweepGuardedExpiryEntry, sweepAuditProvenanceEntry } from "../sweep";
import type { ExpiryEntry, GuardedExpiryEntry, AuditProvenanceEntry } from "../registry";

/** A fake TransactionClient capturing the bypass_rls set_config and the DELETE. */
function makeFakeTx() {
  const executeRaw = vi.fn().mockResolvedValue(undefined); // set_config(...)
  const executeRawUnsafe = vi.fn().mockResolvedValue(7); // DELETE → rows affected
  const tx = {
    $executeRaw: executeRaw,
    $executeRawUnsafe: executeRawUnsafe,
  } as unknown as Prisma.TransactionClient;
  return { tx, executeRaw, executeRawUnsafe };
}

describe("sweepExpiryEntry generated SQL (C2/RT7)", () => {
  it("single-key entry: (id) IN (SELECT id ... LIMIT $1), batchSize is the only bound param", async () => {
    const entry: ExpiryEntry = {
      kind: "EXPIRY",
      table: "sessions",
      cutoffColumn: "expires",
      keyColumns: ["id"],
      globalDelete: true,
    };
    const { tx, executeRawUnsafe } = makeFakeTx();

    const deleted = await sweepExpiryEntry(tx, entry, 100);

    expect(deleted).toBe(7);
    expect(executeRawUnsafe).toHaveBeenCalledOnce();
    const [sql, ...params] = executeRawUnsafe.mock.calls[0];

    // Batch param bound positionally as exactly [batchSize] — no extra params.
    expect(params).toEqual([100]);

    // Batch-bounded WITH picked AS MATERIALIZED (... LIMIT $1) ... (keys) IN
    // (SELECT keys FROM picked) shape (C1) — exact text (Step 0
    // characterization, raw-sql-ident-branded-type plan NF1).
    expect(sql).toBe(
      `WITH picked AS MATERIALIZED (
      SELECT id FROM sessions
      WHERE expires < now()
      LIMIT $1
    )
    DELETE FROM sessions
    WHERE (id) IN (SELECT id FROM picked)`,
    );
    // No template-interpolated non-literal token leaked into the SQL.
    expect(sql).not.toContain("${");
    // batchSize is bound ($1), never inlined as a literal.
    expect(sql).not.toContain("100");
  });

  it("composite-key entry: (identifier, token) IN (SELECT identifier, token ...)", async () => {
    const entry: ExpiryEntry = {
      kind: "EXPIRY",
      table: "verification_tokens",
      cutoffColumn: "expires",
      keyColumns: ["identifier", "token"],
    };
    const { tx, executeRawUnsafe } = makeFakeTx();

    await sweepExpiryEntry(tx, entry, 500);

    const [sql, ...params] = executeRawUnsafe.mock.calls[0];
    expect(params).toEqual([500]);
    expect(sql).toBe(
      `WITH picked AS MATERIALIZED (
      SELECT identifier, token FROM verification_tokens
      WHERE expires < now()
      LIMIT $1
    )
    DELETE FROM verification_tokens
    WHERE (identifier, token) IN (SELECT identifier, token FROM picked)`,
    );
  });

  it("predicate entry: structured clauses concatenated as AND <col> = true AND <col> IS NULL", async () => {
    const entry: ExpiryEntry = {
      kind: "EXPIRY",
      table: "mcp_clients",
      cutoffColumn: "dcr_expires_at",
      keyColumns: ["id"],
      predicate: [
        { column: "is_dcr", op: "=", value: true },
        { column: "tenant_id", op: "IS NULL" },
      ],
      globalDelete: true,
    };
    const { tx, executeRawUnsafe } = makeFakeTx();

    await sweepExpiryEntry(tx, entry, 1000);

    const [sql] = executeRawUnsafe.mock.calls[0];
    // Predicate is rendered from the structured clauses — boolean as a literal,
    // never an interpolated arbitrary value (S1). Exact text (Step 0).
    expect(sql).toBe(
      `WITH picked AS MATERIALIZED (
      SELECT id FROM mcp_clients
      WHERE dcr_expires_at < now() AND is_dcr = true AND tenant_id IS NULL
      LIMIT $1
    )
    DELETE FROM mcp_clients
    WHERE (id) IN (SELECT id FROM picked)`,
    );
    expect(sql).not.toContain("${");
  });

  it("globalDelete entry sets the bypass_rls GUC in-tx before deleting (INV-C2b)", async () => {
    const entry: ExpiryEntry = {
      kind: "EXPIRY",
      table: "sessions",
      cutoffColumn: "expires",
      keyColumns: ["id"],
      globalDelete: true,
    };
    const { tx, executeRaw } = makeFakeTx();

    await sweepExpiryEntry(tx, entry, 100);

    // set_config('app.bypass_rls', 'on', true) issued via the tagged-template $executeRaw.
    expect(executeRaw).toHaveBeenCalled();
  });
});

describe("sweepGuardedExpiryEntry generated SQL (SC5 C2/RT7)", () => {
  it("emits both NOT EXISTS guard clauses + (id) IN (SELECT ... LIMIT $1), only batchSize bound", async () => {
    const entry: GuardedExpiryEntry = {
      kind: "EXPIRY_GUARDED",
      table: "mcp_access_tokens",
      cutoffColumn: "expires_at",
      keyColumns: ["id"],
      guard: "MCP_TOKEN_FAMILY_DEAD",
      globalDelete: true,
    };
    const { tx, executeRaw, executeRawUnsafe } = makeFakeTx();

    const deleted = await sweepGuardedExpiryEntry(tx, entry, 250);

    expect(deleted).toBe(7);
    // bypass_rls GUC set in-tx (globalDelete).
    expect(executeRaw).toHaveBeenCalled();

    const [sql, ...params] = executeRawUnsafe.mock.calls[0];
    // Only batchSize is bound — no extra param, never inlined.
    expect(params).toEqual([250]);
    expect(sql).not.toContain("250");
    expect(sql).not.toContain("${");

    // Batch-bounded WITH picked AS MATERIALIZED (... LIMIT $1) ... (id) IN
    // (SELECT id FROM picked) shape (C1) with both family-guard NOT EXISTS
    // clauses (the SC5 protection) — exact text (Step 0).
    expect(sql).toBe(
      `WITH picked AS MATERIALIZED (
      SELECT id FROM mcp_access_tokens
      WHERE expires_at < now()
      AND NOT EXISTS (
       SELECT 1 FROM mcp_refresh_tokens r
       WHERE r.access_token_id = mcp_access_tokens.id
         AND r.revoked_at IS NULL AND r.expires_at > now()
     )
     AND NOT EXISTS (
       SELECT 1 FROM delegation_sessions d
       WHERE d.mcp_token_id = mcp_access_tokens.id
         AND d.revoked_at IS NULL AND d.expires_at > now()
     )
      LIMIT $1
    )
    DELETE FROM mcp_access_tokens
    WHERE (id) IN (SELECT id FROM picked)`,
    );
  });
});

describe("sweepAuditProvenanceEntry generated SQL (SC4 C2/RT7, A2 delete-first)", () => {
  function makeProvenanceTx(rows: Record<string, unknown>[]) {
    const executeRaw = vi.fn().mockResolvedValue(undefined); // set_config
    // The DELETE ... RETURNING goes through $queryRawUnsafe (needs row results).
    const queryRawUnsafe = vi.fn().mockResolvedValue(rows);
    const executeRawUnsafe = vi.fn().mockResolvedValue(undefined); // unused by this fn
    const auditOutbox = { create: vi.fn().mockResolvedValue(undefined) };
    const queryRaw = vi.fn().mockResolvedValue([{ bypass_rls: "on", tenant_id: "" }]);
    // enqueueAuditInWorkerTx does two $queryRaw reads (ctx + tenant exists)
    queryRaw
      .mockResolvedValueOnce([{ bypass_rls: "on", tenant_id: "" }])
      .mockResolvedValue([{ ok: true }]);
    const tx = {
      $executeRaw: executeRaw,
      $queryRaw: queryRaw,
      $queryRawUnsafe: queryRawUnsafe,
      $executeRawUnsafe: executeRawUnsafe,
      auditOutbox,
    } as unknown as Prisma.TransactionClient;
    return { tx, queryRawUnsafe, executeRawUnsafe, auditOutbox, queryRaw };
  }

  it("DELETEs (id) IN (SELECT ... LIMIT $1) RETURNING the provenance projection, then emits audit from RETURNING rows", async () => {
    const entry: AuditProvenanceEntry = {
      kind: "EXPIRY_AUDIT_PROVENANCE",
      table: "extension_tokens",
      cutoffColumn: "expires_at",
      provenanceColumns: ["tenant_id", "user_id", "last_used_at", "last_used_ip", "last_used_user_agent"],
      auditAction: "CREDENTIAL_RETENTION_PURGED",
      globalDelete: true,
    };
    const rows = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        tenant_id: "22222222-2222-4222-8222-222222222222",
        user_id: "33333333-3333-4333-8333-333333333333",
        last_used_at: null,
        last_used_ip: "10.0.0.1",
        last_used_user_agent: "ua",
      },
    ];
    const { tx, queryRawUnsafe, auditOutbox } = makeProvenanceTx(rows);

    const deleted = await sweepAuditProvenanceEntry(tx, entry, 100);
    expect(deleted).toBe(1);

    // DELETE: batch-bounded WITH picked AS MATERIALIZED (... LIMIT $1) ... (id)
    // IN (SELECT id FROM picked), RETURNING id + all provenance cols, no FOR
    // UPDATE (the DELETE itself takes the row lock). Exact text (Step 0).
    const [deleteSql, ...deleteParams] = queryRawUnsafe.mock.calls[0];
    expect(deleteParams).toEqual([100]);
    expect(deleteSql).toBe(
      `WITH picked AS MATERIALIZED (
         SELECT id FROM extension_tokens
         WHERE expires_at < now()
         LIMIT $1
       )
       DELETE FROM extension_tokens
       WHERE (id) IN (SELECT id FROM picked)
       RETURNING id, tenant_id, user_id, last_used_at, last_used_ip, last_used_user_agent`,
    );
    expect(deleteSql).not.toContain("FOR UPDATE");

    // Audit emitted AFTER delete, from the RETURNING row, under the row's own tenant_id.
    expect(auditOutbox.create).toHaveBeenCalledTimes(1);
    const emitted = auditOutbox.create.mock.calls[0][0];
    expect(emitted.data.tenantId).toBe("22222222-2222-4222-8222-222222222222");
    // Credential tables emit CREDENTIAL_RETENTION_PURGED (entry.auditAction).
    expect(emitted.data.payload.action).toBe("CREDENTIAL_RETENTION_PURGED");
  });

  it("returns 0 and emits nothing when no rows are expired", async () => {
    const entry: AuditProvenanceEntry = {
      kind: "EXPIRY_AUDIT_PROVENANCE",
      table: "api_keys",
      cutoffColumn: "expires_at",
      provenanceColumns: ["tenant_id", "user_id", "name", "last_used_at"],
      auditAction: "CREDENTIAL_RETENTION_PURGED",
      globalDelete: true,
    };
    const { tx, auditOutbox } = makeProvenanceTx([]);
    const deleted = await sweepAuditProvenanceEntry(tx, entry, 100);
    expect(deleted).toBe(0);
    expect(auditOutbox.create).not.toHaveBeenCalled();
  });

  it("SC6 security-record entry emits SECURITY_RECORD_RETENTION_PURGED (auditAction parameterization)", async () => {
    const entry: AuditProvenanceEntry = {
      kind: "EXPIRY_AUDIT_PROVENANCE",
      table: "team_invitations",
      cutoffColumn: "expires_at",
      provenanceColumns: [
        "tenant_id",
        "invited_by_id",
        "email",
        "status",
        "created_at",
      ],
      auditAction: "SECURITY_RECORD_RETENTION_PURGED",
      globalDelete: true,
    };
    const rows = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        tenant_id: "22222222-2222-4222-8222-222222222222",
        invited_by_id: "33333333-3333-4333-8333-333333333333",
        email: "invitee@example.com",
        status: "PENDING",
        created_at: null,
      },
    ];
    const { tx, auditOutbox } = makeProvenanceTx(rows);

    const deleted = await sweepAuditProvenanceEntry(tx, entry, 100);
    expect(deleted).toBe(1);

    const emitted = auditOutbox.create.mock.calls[0][0];
    expect(emitted.data.payload.action).toBe("SECURITY_RECORD_RETENTION_PURGED");
  });

  it("SC6b emergency-grant entry appends the EMERGENCY_GRANT_DEAD guard (both OR-branches) to the SELECT", async () => {
    const entry: AuditProvenanceEntry = {
      kind: "EXPIRY_AUDIT_PROVENANCE",
      table: "emergency_access_grants",
      cutoffColumn: "created_at",
      provenanceColumns: ["tenant_id", "owner_id", "status", "token_expires_at"],
      auditAction: "SECURITY_RECORD_RETENTION_PURGED",
      guard: "EMERGENCY_GRANT_DEAD",
      globalDelete: true,
    };
    const { tx, queryRawUnsafe } = makeProvenanceTx([]);

    await sweepAuditProvenanceEntry(tx, entry, 100);

    const [deleteSql] = queryRawUnsafe.mock.calls[0];
    // The guard restricts to DEAD grants only — both OR-branches present so a
    // live ACCEPTED/ACTIVATED grant (past its invite window) is never selected.
    // The guard lives in the DELETE's inner SELECT (the batch-bound id list).
    // Exact text (Step 0).
    expect(deleteSql).toBe(
      `WITH picked AS MATERIALIZED (
         SELECT id FROM emergency_access_grants
         WHERE created_at < now() AND (
       emergency_access_grants.status IN ('REVOKED', 'REJECTED')
       OR (emergency_access_grants.status = 'PENDING' AND emergency_access_grants.token_expires_at < now())
     )
         LIMIT $1
       )
       DELETE FROM emergency_access_grants
       WHERE (id) IN (SELECT id FROM picked)
       RETURNING id, tenant_id, owner_id, status, token_expires_at`,
    );
  });

  it("entries WITHOUT a guard append no guard SQL (SC4/SC6 unguarded path unchanged)", async () => {
    const entry: AuditProvenanceEntry = {
      kind: "EXPIRY_AUDIT_PROVENANCE",
      table: "api_keys",
      cutoffColumn: "expires_at",
      provenanceColumns: ["tenant_id", "user_id"],
      auditAction: "CREDENTIAL_RETENTION_PURGED",
      globalDelete: true,
    };
    const { tx, queryRawUnsafe } = makeProvenanceTx([]);
    await sweepAuditProvenanceEntry(tx, entry, 100);
    const [deleteSql] = queryRawUnsafe.mock.calls[0];
    expect(deleteSql).not.toContain("status IN");
    // Exact text (Step 0).
    expect(deleteSql).toBe(
      `WITH picked AS MATERIALIZED (
         SELECT id FROM api_keys
         WHERE expires_at < now()
         LIMIT $1
       )
       DELETE FROM api_keys
       WHERE (id) IN (SELECT id FROM picked)
       RETURNING id, tenant_id, user_id`,
    );
  });

  it("entries WITH retentionDays push the cutoff back and bind the days as $2 (M2 grace window)", async () => {
    const entry: AuditProvenanceEntry = {
      kind: "EXPIRY_AUDIT_PROVENANCE",
      table: "access_requests",
      cutoffColumn: "expires_at",
      provenanceColumns: ["tenant_id", "status"],
      auditAction: "SECURITY_RECORD_RETENTION_PURGED",
      globalDelete: true,
      retentionDays: 30,
    };
    const { tx, queryRawUnsafe } = makeProvenanceTx([]);
    await sweepAuditProvenanceEntry(tx, entry, 100);
    const [deleteSql, ...deleteParams] = queryRawUnsafe.mock.calls[0];
    // Exact text (Step 0).
    expect(deleteSql).toBe(
      `WITH picked AS MATERIALIZED (
         SELECT id FROM access_requests
         WHERE expires_at < now() - ($2 || ' days')::interval
         LIMIT $1
       )
       DELETE FROM access_requests
       WHERE (id) IN (SELECT id FROM picked)
       RETURNING id, tenant_id, status`,
    );
    // retentionDays is bound as $2 (a value), never interpolated into the SQL text.
    expect(deleteParams).toEqual([100, 30]);
  });

  // T7(b): GUC-guard failure direction. enqueueAuditInWorkerTx's own bypass_rls
  // check must reject when the GUC context is "off" and tenant_id does not
  // match the row's tenant — proving the guard is not a silent no-op.
  it("rejects when the bypass_rls GUC context reads 'off' (T7 GUC-guard failure direction)", async () => {
    const entry: AuditProvenanceEntry = {
      kind: "EXPIRY_AUDIT_PROVENANCE",
      table: "extension_tokens",
      cutoffColumn: "expires_at",
      provenanceColumns: ["tenant_id", "user_id"],
      auditAction: "CREDENTIAL_RETENTION_PURGED",
      globalDelete: true,
    };
    const deletedRow = {
      id: "11111111-1111-4111-8111-111111111111",
      tenant_id: "22222222-2222-4222-8222-222222222222",
      user_id: "33333333-3333-4333-8333-333333333333",
    };
    const { tx, queryRaw, queryRawUnsafe } = makeProvenanceTx([deletedRow]);
    // Override the GUC context read: bypass_rls is "off" and tenant_id does not
    // match the row's tenant — enqueueAuditInWorkerTx must throw rather than
    // silently proceed to write the outbox row.
    queryRaw.mockReset().mockResolvedValueOnce([{ bypass_rls: "off", tenant_id: "" }]);

    await expect(sweepAuditProvenanceEntry(tx, entry, 100)).rejects.toThrow(
      /bypass_rls scope/,
    );

    // The DELETE was still issued once (it precedes the per-row GUC check in
    // the same tx) — the guard failure surfaces via a rejected promise, and
    // callers run this inside $transaction so the DELETE is rolled back.
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
  });
});
