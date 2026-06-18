/**
 * Unit-level SQL-shape assertions for sweepExpiryEntry (C2 acceptance / RT7).
 *
 * The integration tests prove BEHAVIOR (correct rows deleted on a live DB).
 * This unit test pins the generated SQL TEXT and parameter binding — the
 * string-building surface (keyList join, predicate concatenation, the
 * (keys) IN (SELECT ... LIMIT $1) shape) — so a regression that double-binds,
 * binds an extra param, or leaks a non-literal token into the SQL is caught
 * even when the row math coincidentally still matches.
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

    // Batch-bounded (keys) IN (SELECT keys ... LIMIT $1) shape.
    expect(sql).toMatch(
      /DELETE FROM sessions\s+WHERE \(id\) IN \(\s*SELECT id FROM sessions\s+WHERE expires < now\(\)\s+LIMIT \$1\s*\)/,
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
    expect(sql).toMatch(
      /DELETE FROM verification_tokens\s+WHERE \(identifier, token\) IN \(\s*SELECT identifier, token FROM verification_tokens\s+WHERE expires < now\(\)\s+LIMIT \$1\s*\)/,
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
    // never an interpolated arbitrary value (S1).
    expect(sql).toContain(
      "WHERE dcr_expires_at < now() AND is_dcr = true AND tenant_id IS NULL",
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

    // Batch-bounded (id) IN (SELECT id ... LIMIT $1) shape with the cutoff.
    expect(sql).toMatch(
      /DELETE FROM mcp_access_tokens\s+WHERE \(id\) IN \(\s*SELECT id FROM mcp_access_tokens\s+WHERE expires_at < now\(\)/,
    );
    expect(sql).toMatch(/LIMIT \$1/);

    // Both family-guard NOT EXISTS clauses present (the SC5 protection).
    expect(sql).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM mcp_refresh_tokens r\s+WHERE r\.access_token_id = mcp_access_tokens\.id\s+AND r\.revoked_at IS NULL AND r\.expires_at > now\(\)/,
    );
    expect(sql).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM delegation_sessions d\s+WHERE d\.mcp_token_id = mcp_access_tokens\.id\s+AND d\.revoked_at IS NULL AND d\.expires_at > now\(\)/,
    );
  });
});

describe("sweepAuditProvenanceEntry generated SQL (SC4 C2/RT7)", () => {
  function makeProvenanceTx(rows: Record<string, unknown>[]) {
    const executeRaw = vi.fn().mockResolvedValue(undefined); // set_config
    const queryRawUnsafe = vi.fn().mockResolvedValue(rows); // SELECT (capture)
    const executeRawUnsafe = vi.fn().mockResolvedValue(rows.length); // DELETE
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
    return { tx, queryRawUnsafe, executeRawUnsafe, auditOutbox };
  }

  it("SELECTs the provenance projection (no row lock), then DELETEs id = ANY($1::uuid[])", async () => {
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
    const { tx, queryRawUnsafe, executeRawUnsafe, auditOutbox } =
      makeProvenanceTx(rows);

    const deleted = await sweepAuditProvenanceEntry(tx, entry, 100);
    expect(deleted).toBe(1);

    // SELECT: projection includes id + all provenance cols, LIMIT $1, no FOR UPDATE.
    const [selectSql, ...selectParams] = queryRawUnsafe.mock.calls[0];
    expect(selectParams).toEqual([100]);
    expect(selectSql).toMatch(
      /SELECT id, tenant_id, user_id, last_used_at, last_used_ip, last_used_user_agent FROM extension_tokens/,
    );
    expect(selectSql).toMatch(/WHERE expires_at < now\(\)/);
    expect(selectSql).toMatch(/LIMIT \$1/);
    // No FOR UPDATE — that needs UPDATE privilege; the GC role has only SELECT+DELETE.
    expect(selectSql).not.toContain("FOR UPDATE");

    // Audit emitted BEFORE delete, under the row's own tenant_id.
    expect(auditOutbox.create).toHaveBeenCalledTimes(1);
    const emitted = auditOutbox.create.mock.calls[0][0];
    expect(emitted.data.tenantId).toBe("22222222-2222-4222-8222-222222222222");
    // Credential tables emit CREDENTIAL_RETENTION_PURGED (entry.auditAction).
    expect(emitted.data.payload.action).toBe("CREDENTIAL_RETENTION_PURGED");

    // DELETE binds the captured ids as $1::uuid[], not interpolated.
    const [deleteSql, ...deleteParams] = executeRawUnsafe.mock.calls[0];
    expect(deleteSql).toMatch(/DELETE FROM extension_tokens WHERE id = ANY\(\$1::uuid\[\]\)/);
    expect(deleteParams).toEqual([["11111111-1111-4111-8111-111111111111"]]);
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
    const { tx, executeRawUnsafe, auditOutbox } = makeProvenanceTx([]);
    const deleted = await sweepAuditProvenanceEntry(tx, entry, 100);
    expect(deleted).toBe(0);
    expect(auditOutbox.create).not.toHaveBeenCalled();
    expect(executeRawUnsafe).not.toHaveBeenCalled(); // no DELETE issued
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
});
