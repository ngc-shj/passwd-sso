/**
 * Maps the retention-GC worker's validated env onto the options sweepOnce
 * reads. Called by scripts/retention-gc-worker.ts to fill WorkerConfig, so the
 * mapping is unit-tested on its own (the entrypoint itself runs only as a
 * process).
 */

import { BLOB_ORPHAN_GRACE_REPORT_DEFAULT_MS, BLOB_SWEEP_MODE, type BlobSweepMode } from "@/lib/blob-store/constants";
import type { BlobSweepSettings } from "./sweep";

/** The worker env fields this mapping reads (scripts/retention-gc-worker.ts pick list). */
export interface RetentionGcSweepEnv {
  RETENTION_GC_INTERVAL_MS: number;
  RETENTION_GC_EMIT_HEARTBEAT_AUDIT: boolean;
  RETENTION_GC_TEAM_KEY_PRUNE_ENABLED: boolean;
  RETENTION_GC_BLOB_SWEEP_MODE: BlobSweepMode;
  RETENTION_GC_BLOB_ORPHAN_GRACE_MS?: number;
  RETENTION_GC_BLOB_SWEEP_MAX_OBJECTS: number;
  RETENTION_GC_BLOB_SWEEP_MAX_DELETES: number;
  RETENTION_GC_BLOB_SWEEP_MAX_DELETE_RATIO: number;
  DEPLOYMENT_ID?: string;
}

export interface RetentionGcSweepOptions {
  intervalMs: number;
  emitHeartbeatAudit: boolean;
  teamKeyPrune: boolean;
  blobSweep: BlobSweepSettings;
}

export function buildSweepOpts(env: RetentionGcSweepEnv): RetentionGcSweepOptions {
  const base = {
    intervalMs: env.RETENTION_GC_INTERVAL_MS,
    emitHeartbeatAudit: env.RETENTION_GC_EMIT_HEARTBEAT_AUDIT,
    teamKeyPrune: env.RETENTION_GC_TEAM_KEY_PRUNE_ENABLED,
  };
  const mode = env.RETENTION_GC_BLOB_SWEEP_MODE;
  if (mode === BLOB_SWEEP_MODE.OFF) return { ...base, blobSweep: { mode } };
  // The worker schema's refine requires DEPLOYMENT_ID when the mode is not
  // off; this holds the same rule for any other caller.
  if (!env.DEPLOYMENT_ID) {
    throw new Error("RETENTION_GC_BLOB_SWEEP_MODE requires DEPLOYMENT_ID");
  }
  // Deleting needs a grace period chosen against the backup retention window;
  // only report mode, which deletes nothing, falls back to a default.
  const graceMs = env.RETENTION_GC_BLOB_ORPHAN_GRACE_MS ??
    (mode === BLOB_SWEEP_MODE.REPORT ? BLOB_ORPHAN_GRACE_REPORT_DEFAULT_MS : undefined);
  if (graceMs === undefined) {
    throw new Error("RETENTION_GC_BLOB_ORPHAN_GRACE_MS is required in the deleting sweep mode");
  }
  return {
    ...base,
    blobSweep: {
      mode,
      graceMs,
      maxObjects: env.RETENTION_GC_BLOB_SWEEP_MAX_OBJECTS,
      maxDeletes: env.RETENTION_GC_BLOB_SWEEP_MAX_DELETES,
      maxDeleteRatio: env.RETENTION_GC_BLOB_SWEEP_MAX_DELETE_RATIO,
      deploymentId: env.DEPLOYMENT_ID,
    },
  };
}
