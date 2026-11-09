import {
  BLOB_STORAGE,
  type AttachmentBlobStore,
} from "@/lib/blob-store/types";

export const dbBlobStore: AttachmentBlobStore = {
  backend: BLOB_STORAGE.DB,
  validateConfig() {
    // No external config required.
  },
  async putObject(data) {
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  },
  async getObject(stored) {
    return Buffer.from(stored);
  },
  async deleteObject() {
    // No external object to delete.
  },
  async listObjects() {
    // Payloads live in the attachments rows; there is no object to list.
    return { objects: [] };
  },
  async readMarker() {
    return null;
  },
  async createMarker() {
    throw new Error("The DB blob backend has no object store to mark");
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
