import {
  BLOB_STORAGE,
  type AttachmentBlobStore,
} from "@/lib/blob-store/types";

/**
 * Transitional adapter:
 * current attachment schema stores encrypted payload inline in DB.
 * S3 object I/O integration will be added behind this adapter next.
 */
export const s3BlobStore: AttachmentBlobStore = {
  backend: BLOB_STORAGE.S3,
  toStored(data) {
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  },
  toBuffer(stored) {
    return Buffer.from(stored);
  },
  toBase64(stored) {
    return Buffer.from(stored).toString("base64");
  },
};

