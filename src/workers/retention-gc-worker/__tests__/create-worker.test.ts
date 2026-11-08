/**
 * createWorker owns the orphan-blob sweep's cursor for the process lifetime
 * (#1010, R3-2): every tick hands sweepOnce the identical cursor object, so a
 * value set in one tick is seen in the next.
 */

import { describe, it, expect, vi } from "vitest";
import type { SweepOpts } from "../sweep";

const { sweepOnce } = vi.hoisted(() => ({ sweepOnce: vi.fn() }));

vi.mock("@/lib/db/pool-factory", () => ({
  createPool: () => ({ on: vi.fn(), end: vi.fn(async () => {}) }),
  createPrismaClient: () => ({ $disconnect: vi.fn(async () => {}) }),
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock("../sweep", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sweep")>()),
  sweepOnce,
}));

import { createWorker } from "../index";
import { BLOB_SWEEP_MODE } from "@/lib/blob-store/constants";

describe("createWorker", () => {
  it("passes the same blobCursor object to every tick, carrying state between them", async () => {
    const seen: Array<{ cursor: SweepOpts["blobCursor"]; value: string | undefined }> = [];
    const worker = createWorker({
      databaseUrl: "postgresql://unused@localhost/unused",
      intervalMs: 1,
      batchSize: 10,
      emitHeartbeatAudit: false,
      teamKeyPrune: true,
      blobSweep: { mode: BLOB_SWEEP_MODE.OFF },
    });
    const stopped = new Promise<void>((resolve) => {
      sweepOnce.mockImplementation(async (_prisma: unknown, _batch: number, opts: SweepOpts) => {
        seen.push({ cursor: opts.blobCursor, value: opts.blobCursor?.value });
        if (opts.blobCursor) opts.blobCursor.value = `tick-${seen.length}`;
        if (seen.length === 3) void worker.stop().then(resolve);
        return {};
      });
    });

    void worker.start();
    await stopped;

    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen[0].cursor).toBeDefined();
    for (const tick of seen) expect(tick.cursor).toBe(seen[0].cursor);
    expect(seen.map((t) => t.value).slice(0, 3)).toEqual([undefined, "tick-1", "tick-2"]);
    expect(sweepOnce.mock.calls[0][2]).toMatchObject({ teamKeyPrune: true, blobSweep: { mode: "off" } });
  });
});
