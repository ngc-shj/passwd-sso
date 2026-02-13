export type BlobBackend = "db";

/**
 * Minimal storage boundary for attachment binary payloads.
 *
 * Current implementation stores encrypted bytes in the DB.
 * Future backends (S3/Azure/GCS) should implement the same contract
 * behind this interface so API routes stay provider-agnostic.
 */
export interface AttachmentBlobStore {
  readonly backend: BlobBackend;
  toStored(data: Uint8Array | Buffer): Uint8Array;
  toBuffer(stored: Uint8Array): Buffer;
  toBase64(stored: Uint8Array): string;
}

