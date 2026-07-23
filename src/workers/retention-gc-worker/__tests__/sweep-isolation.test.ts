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

    // PER_TENANT_TRASH entries dispatch through sweepTrashEntry (not an outer
    // $transaction), which first calls workerPrisma.tenant.findMany. Returning
    // [] makes those entries report 0 with no inner tx — keeping the $transaction
    // call sequence aligned 1:1 with the non-trash entries.
    const txEntryOrder = RETENTION_REGISTRY.filter(
      (e) => e.kind !== "PER_TENANT_TRASH",
    ).map((e) => e.table);
    const trashTables = RETENTION_REGISTRY.filter(
      (e) => e.kind === "PER_TENANT_TRASH",
    ).map((e) => e.table);
    const entryOrder = RETENTION_REGISTRY.map((e) => e.table);

    // sweepOnce (C7) fires ONE extra $transaction BEFORE the registry loop for
    // sweepExpiredAccessRequests. Account for it as call 0 (returns 0 — no
    // access_requests rows expired in this fixture) so the registry-entry
    // mapping below stays aligned.
    let callIndex = -1;
    // Each non-trash registry entry triggers one $transaction call, in registry
    // order. sweepOnce ALSO fires one EXTRA $transaction for the heartbeat after
    // the entries (because a sibling deleted >0 → anyDeleted). That extra call
    // has callIndex === txEntryOrder.length; we return 0 for it (txEntryOrder[i]
    // is undefined there) and the mock ignores the callback, so the heartbeat
    // emit never runs and its result is discarded by sweepOnce — invisible to
    // the assertions below. Guard it explicitly so a future mock that DOES
    // invoke the callback can't silently misalign the per-entry mapping.
    const mockPrisma = {
      tenant: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async () => {
        if (callIndex === -1) {
          callIndex += 1;
          return 0; // C7 pre-step tx (sweepExpiredAccessRequests) — no rows expired
        }
        if (callIndex >= txEntryOrder.length) {
          callIndex += 1;
          return 0; // heartbeat tx — result discarded by sweepOnce
        }
        const table = txEntryOrder[callIndex];
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

    // Every non-trash sibling still ran and reported its count (3) — isolation.
    for (const table of txEntryOrder) {
      if (table === failingTable) continue;
      expect(counts[table]).toBe(3);
    }
    // Trash entries (no tenants enumerated) report 0 and don't abort the sweep.
    for (const table of trashTables) {
      expect(counts[table]).toBe(0);
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
