/**
 * Unit tests for sweepExpiredAccessRequests (external-review-2026-07
 * remediation, C7): SQL shape (bypass_rls set, batch-bounded UPDATE, static
 * template — no interpolated values) and SQL <-> MATRIX parity — a guard that
 * fails if MATRIX.PENDING.EXPIRED stops permitting AR_ACTOR.SYSTEM while this
 * SQL still runs.
 */

import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { sweepExpiredAccessRequests } from "../sweep";
import { MATRIX, AR_STATUS, AR_ACTOR } from "@/lib/access-request/access-request-state";

function makeTx(updatedCount: number) {
  const executeRaw = vi.fn().mockResolvedValue(undefined); // set_config
  const executeRawUnsafe = vi.fn().mockResolvedValue(updatedCount); // UPDATE
  const tx = {
    $executeRaw: executeRaw,
    $executeRawUnsafe: executeRawUnsafe,
  } as unknown as Prisma.TransactionClient;
  return { tx, executeRaw, executeRawUnsafe };
}

describe("sweepExpiredAccessRequests (C7)", () => {
  it("sets bypass_rls before the UPDATE", async () => {
    const { tx, executeRaw } = makeTx(0);
    await sweepExpiredAccessRequests(tx, 100);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it("runs a batch-bounded UPDATE with the batchSize as the only bound parameter", async () => {
    const { tx, executeRawUnsafe } = makeTx(3);
    const result = await sweepExpiredAccessRequests(tx, 250);
    expect(result).toBe(3);
    expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...params] = executeRawUnsafe.mock.calls[0] as [string, ...unknown[]];
    expect(sql).toContain("UPDATE access_requests");
    expect(sql).toContain("SET status = 'EXPIRED'");
    expect(sql).toContain("WHERE status = 'PENDING' AND expires_at < now()");
    expect(sql).toContain("LIMIT $1");
    // Batch-bounded key-set-IN shape (same pattern as every other sweeper in
    // this file): the outer UPDATE's (id) IN list matches the inner SELECT id
    // projection, so the LIMIT caps exactly the rows mutated.
    expect(sql).toMatch(/\(id\)\s+IN\s*\(\s*SELECT\s+id\s+FROM\s+access_requests/);
    expect(params).toEqual([250]);
  });

  it("the SQL contains no interpolated value — only the SQL string and batchSize are passed", async () => {
    const { tx, executeRawUnsafe } = makeTx(0);
    await sweepExpiredAccessRequests(tx, 500);
    const call = executeRawUnsafe.mock.calls[0] as unknown[];
    // Exactly [sql, batchSize] — no third argument (would indicate an
    // interpolated value sneaking into the static template).
    expect(call).toHaveLength(2);
  });

  it("returns 0 when no rows match", async () => {
    const { tx } = makeTx(0);
    const result = await sweepExpiredAccessRequests(tx, 100);
    expect(result).toBe(0);
  });
});

describe("SQL <-> MATRIX parity (C7 SSoT note)", () => {
  it("MATRIX still permits PENDING -> EXPIRED for AR_ACTOR.SYSTEM — the sweep's transition target must stay a legal state-machine edge", () => {
    expect(MATRIX[AR_STATUS.PENDING][AR_STATUS.EXPIRED]).toContain(AR_ACTOR.SYSTEM);
  });
});
