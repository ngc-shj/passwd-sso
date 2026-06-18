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
import { sweepExpiryEntry, sweepGuardedExpiryEntry } from "../sweep";
import type { ExpiryEntry, GuardedExpiryEntry } from "../registry";

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
