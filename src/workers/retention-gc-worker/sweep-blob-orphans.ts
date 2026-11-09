/**
 * Orphaned attachment-object sweep for the retention-GC worker (#1010).
 *
 * Deletes objects in the external blob store that no `attachments` row
 * references. An object is deleted only when ALL of these hold:
 *
 * - the bucket carries this deployment's marker (`<prefix>.passwd-sso-deployment`
 *   whose body equals DEPLOYMENT_ID; created by the operator with
 *   `--init-blob-marker`, only ever read here);
 * - its key parses as an attachment key under the current prefix
 *   (parseObjectKey: UUID ids, generation or legacy form);
 * - it is older than the grace period (`lastModified <= now - graceMs`);
 * - no row with its attachment id has a ref naming its EXACT key;
 * - the tick passed the breaker: at least one referenced key was seen in the
 *   current cursor pass (positive evidence the database is this bucket's),
 *   the unreferenced old keys are at most 20 or at most `maxDeleteRatio` of
 *   the parseable old keys, and at most `maxDeletes`.
 *
 * A tick classifies up to `maxObjects` keys page by page (no transaction is
 * open while listing; the row read is its own short transaction under the
 * RLS bypass, through `readRefs`), then decides on the tick's cumulative
 * counts, then deletes outside any transaction. The cursor is the caller's
 * (createWorker owns it for the process lifetime), so a bucket larger than
 * `maxObjects` is covered over successive ticks; it resets when a listing
 * completes and on a list error. A refused tick still advances the cursor,
 * so a dense orphan stretch never wedges the sweep.
 *
 * Memory per tick: `maxObjects` classified keys, at most `maxDeletes + 1`
 * held unreferenced keys. Logs carry counts only; store errors are logged as
 * errorLogFields plus the HTTP status (an S3 error message embeds the key).
 */

import type { Logger } from "pino";
import type { AttachmentBlobStore } from "@/lib/blob-store/types";
import {
  decodeObjectRef,
  encodeObjectRef,
  objectKeyPrefix,
  parseObjectKey,
  type ParsedObjectKey,
} from "@/lib/blob-store/object-ref";
import { blobErrorStatus } from "@/lib/blob-store/errors";
import { errorLogFields } from "@/lib/logger/error-fields";
import { BLOB_SWEEP_MODE } from "@/lib/blob-store/constants";

export const BLOB_SWEEP_REFUSAL = {
  MARKER_MISSING: "marker_missing",
  MARKER_MISMATCH: "marker_mismatch",
  BREAKER: "breaker",
} as const;

export type BlobSweepRefusal = (typeof BLOB_SWEEP_REFUSAL)[keyof typeof BLOB_SWEEP_REFUSAL];

/** S3's ListObjectsV2 maximum; tests pass a smaller page through opts. */
export const BLOB_SWEEP_PAGE_SIZE = 1000;

/** Unreferenced old keys a tick may hold before the ratio applies. */
export const BLOB_SWEEP_RATIO_FLOOR = 20;

/** Cursor state across ticks, owned by createWorker for the process lifetime. */
export interface BlobCursor {
  value?: string;
  /** A referenced key was seen in the current pass (reset when a pass ends). */
  sawReferenced: boolean;
}

export interface BlobSweepOptions {
  mode: typeof BLOB_SWEEP_MODE.REPORT | typeof BLOB_SWEEP_MODE.DELETE;
  graceMs: number;
  maxObjects: number;
  maxDeletes: number;
  pageSize: number;
  maxDeleteRatio: number;
  deploymentId: string;
}

export interface AttachmentRefRow {
  id: string;
  encryptedData: Uint8Array;
}

export interface BlobSweepDeps {
  readRefs: (ids: string[]) => Promise<AttachmentRefRow[]>;
  store: AttachmentBlobStore;
  now: () => Date;
  log: Pick<Logger, "info" | "warn" | "error">;
}

export interface BlobSweepResult {
  listed: number;
  unparseable: number;
  young: number;
  referenced: number;
  deleted: number;
  wouldDelete: number;
  deleteFailed: number;
  refused?: BlobSweepRefusal;
}

export const BLOB_SWEEP_LIST_FAILED_CODE = "RETENTION_GC_BLOB_LIST_FAILED";

interface Candidate {
  key: string;
  parsed: ParsedObjectKey;
}

function resetCursor(cursor: BlobCursor): void {
  cursor.value = undefined;
  cursor.sawReferenced = false;
}

export async function sweepOrphanBlobs(
  deps: BlobSweepDeps,
  opts: BlobSweepOptions,
  cursor: BlobCursor,
): Promise<BlobSweepResult> {
  const { store, log } = deps;
  const result: BlobSweepResult = {
    listed: 0,
    unparseable: 0,
    young: 0,
    referenced: 0,
    deleted: 0,
    wouldDelete: 0,
    deleteFailed: 0,
  };

  const marker = await store.readMarker();
  if (marker !== opts.deploymentId) {
    const refused = marker === null ? BLOB_SWEEP_REFUSAL.MARKER_MISSING : BLOB_SWEEP_REFUSAL.MARKER_MISMATCH;
    log.warn({ refused, _logType: "retention-gc.blob_sweep_refused" }, "retention-gc.blob_sweep_refused");
    return { ...result, refused };
  }

  // ── Classify ──
  const cutoff = deps.now().getTime() - opts.graceMs;
  const prefix = objectKeyPrefix();
  const candidates: Candidate[] = [];
  let parseableOld = 0;
  let unreferencedOld = 0;
  let passComplete = false;

  while (result.listed < opts.maxObjects) {
    let page;
    try {
      page = await store.listObjects(prefix, {
        cursor: cursor.value,
        pageSize: Math.min(opts.pageSize, opts.maxObjects - result.listed),
      });
    } catch (err) {
      resetCursor(cursor);
      const httpStatusCode = blobErrorStatus(err);
      log.error(
        { error: errorLogFields(err), httpStatusCode, _logType: "retention-gc.blob_sweep_list_failed" },
        "retention-gc.blob_sweep_list_failed",
      );
      throw Object.assign(new Error("retention-gc blob sweep: listing failed"), {
        code: BLOB_SWEEP_LIST_FAILED_CODE,
      });
    }

    const old: Candidate[] = [];
    for (const object of page.objects) {
      result.listed++;
      const parsed = parseObjectKey(object.key);
      if (!parsed) {
        result.unparseable++;
        continue;
      }
      if (object.lastModified.getTime() > cutoff) {
        result.young++;
        continue;
      }
      old.push({ key: object.key, parsed });
    }

    if (old.length > 0) {
      const rows = await deps.readRefs([...new Set(old.map((c) => c.parsed.attachmentId))]);
      const refKeys = new Map<string, string | undefined>();
      for (const row of rows) refKeys.set(row.id.toLowerCase(), decodeObjectRef(row.encryptedData)?.key);
      parseableOld += old.length;
      for (const candidate of old) {
        if (refKeys.get(candidate.parsed.attachmentId) === candidate.key) {
          result.referenced++;
          cursor.sawReferenced = true;
          continue;
        }
        unreferencedOld++;
        if (candidates.length <= opts.maxDeletes) candidates.push(candidate);
      }
    }

    cursor.value = page.cursor;
    if (!page.cursor) {
      passComplete = true;
      break;
    }
  }

  // ── Decide ── (only a tick with something to delete can be refused)
  const sawReferenced = cursor.sawReferenced;
  if (passComplete) resetCursor(cursor);

  if (unreferencedOld === 0) return result;

  const overRatio =
    unreferencedOld > BLOB_SWEEP_RATIO_FLOOR && unreferencedOld > opts.maxDeleteRatio * parseableOld;
  if (!sawReferenced || overRatio || unreferencedOld > opts.maxDeletes) {
    log.warn(
      {
        refused: BLOB_SWEEP_REFUSAL.BREAKER,
        sawReferenced,
        listed: result.listed,
        parseableOld,
        unreferencedOld,
        _logType: "retention-gc.blob_sweep_refused",
      },
      "retention-gc.blob_sweep_refused",
    );
    return { ...result, refused: BLOB_SWEEP_REFUSAL.BREAKER };
  }

  if (opts.mode === BLOB_SWEEP_MODE.REPORT) {
    result.wouldDelete = unreferencedOld;
    log.info({ ...result, _logType: "retention-gc.blob_sweep_report" }, "retention-gc.blob_sweep_report");
    return result;
  }

  // ── Delete ── outside any transaction; a failure is counted, never thrown.
  for (const { key, parsed } of candidates) {
    try {
      await store.deleteObject(encodeObjectRef({ key }), {
        attachmentId: parsed.attachmentId,
        entryId: parsed.entryId,
        ...(parsed.teamId !== undefined ? { teamId: parsed.teamId } : {}),
      });
      result.deleted++;
    } catch (err) {
      result.deleteFailed++;
      const httpStatusCode = blobErrorStatus(err);
      log.error(
        { error: errorLogFields(err), httpStatusCode, _logType: "retention-gc.blob_sweep_delete_failed" },
        "retention-gc.blob_sweep_delete_failed",
      );
    }
  }
  log.info({ ...result, _logType: "retention-gc.blob_sweep_done" }, "retention-gc.blob_sweep_done");
  return result;
}
