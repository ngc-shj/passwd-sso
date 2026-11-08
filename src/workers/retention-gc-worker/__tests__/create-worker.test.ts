/**
 * createWorker owns the orphan-blob sweep's cursor for the process lifetime
 * (#1010, R3-2): every tick hands sweepOnce the identical cursor object, so a
 * value set in one tick is seen in the next. At start it reports a blob sweep
 * configured on the db backend, where it would skip every tick (review FF4).
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import type { SweepOpts } from "../sweep";

const { sweepOnce, logError } = vi.hoisted(() => ({ sweepOnce: vi.fn(), logError: vi.fn() }));

vi.mock("@/lib/db/pool-factory", () => ({
  createPool: () => ({ on: vi.fn(), end: vi.fn(async () => {}) }),
  createPrismaClient: () => ({ $disconnect: vi.fn(async () => {}) }),
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), error: logError, warn: vi.fn() }),
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

  describe("a blob sweep on the db backend", () => {
    const savedBackend = process.env.BLOB_BACKEND;
    afterEach(() => {
      if (savedBackend === undefined) delete process.env.BLOB_BACKEND;
      else process.env.BLOB_BACKEND = savedBackend;
      logError.mockReset();
      sweepOnce.mockReset();
    });

    /** Start a worker, let it run one tick, stop it; returns the logged _logType values of error lines. */
    async function startedErrors(mode: (typeof BLOB_SWEEP_MODE)[keyof typeof BLOB_SWEEP_MODE], backend: string): Promise<unknown[]> {
      process.env.BLOB_BACKEND = backend;
      const worker = createWorker({
        databaseUrl: "postgresql://unused@localhost/unused",
        intervalMs: 1,
        batchSize: 10,
        emitHeartbeatAudit: false,
        teamKeyPrune: false,
        blobSweep: mode === BLOB_SWEEP_MODE.OFF ? { mode } : { mode, graceMs: 3_600_000, maxObjects: 100, maxDeletes: 1, maxDeleteRatio: 0.5, deploymentId: "d" },
      });
      const ticked = new Promise<void>((resolve) => {
        sweepOnce.mockImplementation(async () => {
          resolve();
          return {};
        });
      });
      void worker.start();
      await ticked;
      await worker.stop();
      return logError.mock.calls.map(([fields]) => (fields as { _logType?: unknown })._logType);
    }

    it.each([BLOB_SWEEP_MODE.REPORT, BLOB_SWEEP_MODE.DELETE])("mode %s on the db backend logs blob_sweep_inert once at start", async (mode) => {
      expect(await startedErrors(mode, "")).toEqual(["retention-gc.blob_sweep_inert"]);
      expect(logError.mock.calls[0][0]).toEqual({ mode, _logType: "retention-gc.blob_sweep_inert" });
    });

    it("mode off on the db backend stays silent", async () => {
      expect(await startedErrors(BLOB_SWEEP_MODE.OFF, "")).toEqual([]);
    });

    it("mode report on an external backend stays silent", async () => {
      expect(await startedErrors(BLOB_SWEEP_MODE.REPORT, "s3")).toEqual([]);
    });
  });
});
