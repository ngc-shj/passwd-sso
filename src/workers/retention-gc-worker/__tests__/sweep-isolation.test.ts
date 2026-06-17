/**
 * Per-entry error isolation unit test for sweepOnce (C4 / INV-C4b / RT7).
 *
 * Proves the isolation property by genuinely INJECTING a failure: the mocked
 * workerPrisma.$transaction rejects on the call for one specific table and
 * resolves for the others. A real-DB integration test cannot deterministically
 * make exactly one registry entry throw, so the isolation invariant is verified
 * here at the unit level (the integration test covers the happy path + the
 * heartbeat-failure idempotency case).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

import { sweepOnce } from "../sweep";
import { RETENTION_REGISTRY } from "../registry";

describe("sweepOnce per-entry error isolation (C4/INV-C4b/RT7)", () => {
  it("a failing entry yields -1 while sibling entries still report their counts", async () => {
    // The entry chosen to fail — the first EXPIRY table in the registry.
    const failingTable = RETENTION_REGISTRY.find(
      (e) => e.kind === "EXPIRY",
    )!.table;

    let callIndex = 0;
    // Each registry entry triggers one $transaction call, in registry order.
    // Make the call for `failingTable` reject; all others resolve with a count.
    const entryOrder = RETENTION_REGISTRY.map((e) => e.table);
    const mockPrisma = {
      $transaction: vi.fn(async () => {
        const table = entryOrder[callIndex];
        callIndex += 1;
        if (table === failingTable) {
          throw Object.assign(new Error("boom"), { code: "XX000" });
        }
        return 3; // sibling deleted-count
      }),
    } as unknown as Parameters<typeof sweepOnce>[0];

    const counts = await sweepOnce(mockPrisma, 100, {
      intervalMs: 3_600_000,
      emitHeartbeatAudit: false,
    });

    // The failing entry is flagged -1; the sweep did NOT abort.
    expect(counts[failingTable]).toBe(-1);

    // Every sibling entry still ran and reported its count (3), proving isolation.
    for (const table of entryOrder) {
      if (table === failingTable) continue;
      expect(counts[table]).toBe(3);
    }

    // sweepOnce visited every registry entry despite the mid-loop failure.
    expect(Object.keys(counts).sort()).toEqual([...entryOrder].sort());
  });

  it("sweepOnce does not throw when an entry fails (per-entry catch)", async () => {
    const mockPrisma = {
      $transaction: vi.fn(async () => {
        throw Object.assign(new Error("boom"), { code: "XX000" });
      }),
    } as unknown as Parameters<typeof sweepOnce>[0];

    await expect(
      sweepOnce(mockPrisma, 100, {
        intervalMs: 3_600_000,
        emitHeartbeatAudit: false,
      }),
    ).resolves.toBeDefined();
  });
});
