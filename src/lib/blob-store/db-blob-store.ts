import type { AttachmentBlobStore } from "@/lib/blob-store/types";

export const dbBlobStore: AttachmentBlobStore = {
  backend: "db",
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

