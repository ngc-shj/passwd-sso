import {
  BLOB_STORAGE,
  type AttachmentBlobStore,
} from "@/lib/blob-store/types";

/**
 * Transitional adapter:
 * current attachment schema stores encrypted payload inline in DB.
 * GCS object I/O integration will be added behind this adapter next.
 */
export const gcsBlobStore: AttachmentBlobStore = {
  backend: BLOB_STORAGE.GCS,
  validateConfig() {
    if (!process.env.GCS_ATTACHMENTS_BUCKET) {
      throw new Error("GCS backend requires GCS_ATTACHMENTS_BUCKET");
    }
  },
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
