/**
 * buildSweepOpts maps each worker env value into the options sweepOnce reads
 * (#1009 / #1010, C4 wiring cells).
 */

import { describe, it, expect } from "vitest";
import { buildSweepOpts, type RetentionGcSweepEnv } from "../options";
import { BLOB_ORPHAN_GRACE_REPORT_DEFAULT_MS, BLOB_SWEEP_MODE } from "@/lib/blob-store/constants";

const DEPLOYMENT_ID = "550e8400-e29b-41d4-a716-446655440000";

const ENV: RetentionGcSweepEnv = {
  RETENTION_GC_INTERVAL_MS: 120_000,
  RETENTION_GC_EMIT_HEARTBEAT_AUDIT: true,
  RETENTION_GC_TEAM_KEY_PRUNE_ENABLED: false,
  RETENTION_GC_BLOB_SWEEP_MODE: BLOB_SWEEP_MODE.DELETE,
  RETENTION_GC_BLOB_ORPHAN_GRACE_MS: 7_200_000,
  RETENTION_GC_BLOB_SWEEP_MAX_OBJECTS: 500,
  RETENTION_GC_BLOB_SWEEP_MAX_DELETES: 40,
  RETENTION_GC_BLOB_SWEEP_MAX_DELETE_RATIO: 0.25,
  DEPLOYMENT_ID,
};

describe("buildSweepOpts", () => {
  it.each([
    ["RETENTION_GC_INTERVAL_MS", { RETENTION_GC_INTERVAL_MS: 300_000 }, (o: ReturnType<typeof buildSweepOpts>) => o.intervalMs, 300_000],
    ["RETENTION_GC_EMIT_HEARTBEAT_AUDIT", { RETENTION_GC_EMIT_HEARTBEAT_AUDIT: false }, (o: ReturnType<typeof buildSweepOpts>) => o.emitHeartbeatAudit, false],
    ["RETENTION_GC_TEAM_KEY_PRUNE_ENABLED", { RETENTION_GC_TEAM_KEY_PRUNE_ENABLED: true }, (o: ReturnType<typeof buildSweepOpts>) => o.teamKeyPrune, true],
    ["RETENTION_GC_BLOB_SWEEP_MODE", { RETENTION_GC_BLOB_SWEEP_MODE: BLOB_SWEEP_MODE.REPORT }, (o: ReturnType<typeof buildSweepOpts>) => o.blobSweep.mode, "report"],
    ["RETENTION_GC_BLOB_ORPHAN_GRACE_MS", { RETENTION_GC_BLOB_ORPHAN_GRACE_MS: 3_600_000 }, (o: ReturnType<typeof buildSweepOpts>) => "graceMs" in o.blobSweep && o.blobSweep.graceMs, 3_600_000],
    ["RETENTION_GC_BLOB_SWEEP_MAX_OBJECTS", { RETENTION_GC_BLOB_SWEEP_MAX_OBJECTS: 100 }, (o: ReturnType<typeof buildSweepOpts>) => "maxObjects" in o.blobSweep && o.blobSweep.maxObjects, 100],
    ["RETENTION_GC_BLOB_SWEEP_MAX_DELETES", { RETENTION_GC_BLOB_SWEEP_MAX_DELETES: 7 }, (o: ReturnType<typeof buildSweepOpts>) => "maxDeletes" in o.blobSweep && o.blobSweep.maxDeletes, 7],
    ["RETENTION_GC_BLOB_SWEEP_MAX_DELETE_RATIO", { RETENTION_GC_BLOB_SWEEP_MAX_DELETE_RATIO: 1 }, (o: ReturnType<typeof buildSweepOpts>) => "maxDeleteRatio" in o.blobSweep && o.blobSweep.maxDeleteRatio, 1],
    ["DEPLOYMENT_ID", { DEPLOYMENT_ID: "11111111-1111-4111-8111-111111111111" }, (o: ReturnType<typeof buildSweepOpts>) => "deploymentId" in o.blobSweep && o.blobSweep.deploymentId, "11111111-1111-4111-8111-111111111111"],
  ] as const)("maps %s", (_name, change, read, want) => {
    // The base value differs from `want`, so a mapping that ignored the
    // variable would read the base and fail.
    expect(read(buildSweepOpts(ENV))).not.toBe(want);
    expect(read(buildSweepOpts({ ...ENV, ...change }))).toBe(want);
  });

  it("maps mode off to a sweep that carries nothing else", () => {
    expect(buildSweepOpts({ ...ENV, RETENTION_GC_BLOB_SWEEP_MODE: BLOB_SWEEP_MODE.OFF }).blobSweep).toEqual({ mode: "off" });
  });

  it("delete mode refuses an unset grace period", () => {
    expect(() => buildSweepOpts({ ...ENV, RETENTION_GC_BLOB_ORPHAN_GRACE_MS: undefined })).toThrow(
      "RETENTION_GC_BLOB_ORPHAN_GRACE_MS is required",
    );
  });

  it("report mode falls back to the one-day grace period", () => {
    const opts = buildSweepOpts({
      ...ENV,
      RETENTION_GC_BLOB_SWEEP_MODE: BLOB_SWEEP_MODE.REPORT,
      RETENTION_GC_BLOB_ORPHAN_GRACE_MS: undefined,
    });
    expect("graceMs" in opts.blobSweep && opts.blobSweep.graceMs).toBe(BLOB_ORPHAN_GRACE_REPORT_DEFAULT_MS);
  });

  it("refuses a sweeping mode without DEPLOYMENT_ID", () => {
    expect(() => buildSweepOpts({ ...ENV, DEPLOYMENT_ID: undefined })).toThrow("requires DEPLOYMENT_ID");
  });
});
