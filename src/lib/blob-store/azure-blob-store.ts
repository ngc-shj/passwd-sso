import {
  BLOB_STORAGE,
  type AttachmentBlobStore,
} from "@/lib/blob-store/types";

/**
 * Transitional adapter:
 * current attachment schema stores encrypted payload inline in DB.
 * Azure Blob object I/O integration will be added behind this adapter next.
 */
export const azureBlobStore: AttachmentBlobStore = {
  backend: BLOB_STORAGE.AZURE,
  validateConfig() {
    if (!process.env.AZURE_STORAGE_ACCOUNT || !process.env.AZURE_BLOB_CONTAINER) {
      throw new Error(
        "Azure backend requires AZURE_STORAGE_ACCOUNT and AZURE_BLOB_CONTAINER",
      );
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
