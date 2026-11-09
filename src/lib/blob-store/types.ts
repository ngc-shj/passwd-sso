export const BLOB_STORAGE = {
  DB: "db",
  S3: "s3",
  AZURE: "azure",
  GCS: "gcs",
} as const;

export type BlobBackend = (typeof BLOB_STORAGE)[keyof typeof BLOB_STORAGE];

export interface AttachmentBlobContext {
  attachmentId: string;
  entryId: string;
  teamId?: string;
  /**
   * Object-key generation (32 lowercase hex from the server CSPRNG, see
   * newBlobGeneration). Every write gets a fresh one, so a new body never
   * overwrites the object a committed row still references.
   */
  generation?: string;
}

/** A write always names its generation (fixed keys would allow overwrite). */
export type AttachmentBlobPutContext = AttachmentBlobContext & { generation: string };

/** One object of a listing page. */
export interface BlobObjectListing {
  key: string;
  lastModified: Date;
}

/** One listing page; `cursor` is absent once the listing is complete. */
export interface BlobListPage {
  objects: BlobObjectListing[];
  cursor?: string;
}

export const BLOB_MARKER_CREATE = {
  CREATED: "created",
  EXISTS: "exists",
} as const;

export type BlobMarkerCreateResult = (typeof BLOB_MARKER_CREATE)[keyof typeof BLOB_MARKER_CREATE];

/**
 * Minimal storage boundary for attachment binary payloads.
 *
 * Current implementation stores encrypted bytes in the DB.
 * Future backends (S3/Azure/GCS) should implement the same contract
 * behind this interface so API routes stay provider-agnostic.
 */
export interface AttachmentBlobStore {
  readonly backend: BlobBackend;
  validateConfig(): void;
  putObject(
    data: Uint8Array | Buffer,
    context: AttachmentBlobPutContext,
  ): Promise<Uint8Array>;
  getObject(
    stored: Uint8Array,
    context: AttachmentBlobContext,
  ): Promise<Buffer>;
  deleteObject(
    stored: Uint8Array,
    context: AttachmentBlobContext,
  ): Promise<void>;
  /**
   * One page of the objects whose key starts with `prefix`, at most
   * `pageSize`. Pass the returned cursor back for the next page; the DB
   * backend lists nothing.
   */
  listObjects(prefix: string, opts: { cursor?: string; pageSize: number }): Promise<BlobListPage>;
  /** The deployment-ownership marker's body, or null when there is none. */
  readMarker(): Promise<string | null>;
  /** Create the marker with `body` unless one exists; never overwrites. */
  createMarker(body: string): Promise<BlobMarkerCreateResult>;
  toStored(data: Uint8Array | Buffer): Uint8Array;
  toBuffer(stored: Uint8Array): Buffer;
  toBase64(stored: Uint8Array): string;
}
