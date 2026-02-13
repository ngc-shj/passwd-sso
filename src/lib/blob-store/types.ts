export const BLOB_STORAGE = {
  DB: "db",
  S3: "s3",
  AZURE: "azure",
  GCS: "gcs",
} as const;

export type BlobBackend = (typeof BLOB_STORAGE)[keyof typeof BLOB_STORAGE];

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
  toStored(data: Uint8Array | Buffer): Uint8Array;
  toBuffer(stored: Uint8Array): Buffer;
  toBase64(stored: Uint8Array): string;
}
