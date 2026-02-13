import {
  BLOB_STORAGE,
  type AttachmentBlobStore,
} from "@/lib/blob-store/types";
import { loadCloudBlobConfig } from "@/lib/blob-store/config";

/**
 * Transitional adapter:
 * current attachment schema stores encrypted payload inline in DB.
 * Azure Blob object I/O integration will be added behind this adapter next.
 */
export const azureBlobStore: AttachmentBlobStore = {
  backend: BLOB_STORAGE.AZURE,
  validateConfig() {
    loadCloudBlobConfig(BLOB_STORAGE.AZURE);
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
