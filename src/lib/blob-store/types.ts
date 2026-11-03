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
  toStored(data: Uint8Array | Buffer): Uint8Array;
  toBuffer(stored: Uint8Array): Buffer;
  toBase64(stored: Uint8Array): string;
}
