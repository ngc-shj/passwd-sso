import { BLOB_MARKER_CREATE, type BlobMarkerCreateResult } from "@/lib/blob-store/types";

/**
 * Object-store error helpers. A store error is logged as
 * `{ error: errorLogFields(err), httpStatusCode: blobErrorStatus(err) }`, never
 * whole: an S3 error message embeds the object key.
 */

function field(err: unknown, name: string): unknown {
  return err !== null && typeof err === "object" ? (err as Record<string, unknown>)[name] : undefined;
}

/**
 * The HTTP status an SDK error carries: S3 `$metadata.httpStatusCode`, Azure
 * `statusCode`, GCS `code` (numeric).
 */
export function blobErrorStatus(err: unknown): number | undefined {
  const s3 = field(field(err, "$metadata"), "httpStatusCode");
  if (typeof s3 === "number") return s3;
  const azure = field(err, "statusCode");
  if (typeof azure === "number") return azure;
  const gcs = field(err, "code");
  return typeof gcs === "number" ? gcs : undefined;
}

export const HTTP_NOT_FOUND = 404;
export const HTTP_CONFLICT = 409;
export const HTTP_PRECONDITION_FAILED = 412;

/** Runs a read, answering null when the store reports the object absent (404). */
export async function nullIfNotFound<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (blobErrorStatus(err) === HTTP_NOT_FOUND) return null;
    throw err;
  }
}

/**
 * Runs a conditional create, answering EXISTS when the store refuses it with
 * one of `existsStatuses` (the backend's "already there" answers).
 */
export async function createdUnlessExists(
  create: () => Promise<unknown>,
  existsStatuses: readonly number[],
): Promise<BlobMarkerCreateResult> {
  try {
    await create();
    return BLOB_MARKER_CREATE.CREATED;
  } catch (err) {
    const status = blobErrorStatus(err);
    if (status !== undefined && existsStatuses.includes(status)) return BLOB_MARKER_CREATE.EXISTS;
    throw err;
  }
}
