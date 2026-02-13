import {
  BLOB_STORAGE,
  type AttachmentBlobStore,
} from "@/lib/blob-store/types";
import { loadCloudBlobConfig } from "@/lib/blob-store/config";
import { buildObjectKey, decodeObjectRef, encodeObjectRef } from "@/lib/blob-store/object-ref";

let gcsBucketPromise: Promise<{
  file: (key: string) => {
    save: (data: Buffer, options?: unknown) => Promise<unknown>;
    download: () => Promise<[Buffer]>;
    delete: (options?: unknown) => Promise<unknown>;
  };
}> | null = null;

async function getGcsBucket() {
  if (!gcsBucketPromise) {
    gcsBucketPromise = (async () => {
      const moduleName = "@google-cloud/storage";
      const mod = await import(moduleName);
      const { bucket } = loadCloudBlobConfig(BLOB_STORAGE.GCS);
      const storage = new mod.Storage() as {
        bucket: (bucketName: string) => unknown;
      };
      return storage.bucket(bucket) as {
        file: (key: string) => {
          save: (data: Buffer, options?: unknown) => Promise<unknown>;
          download: () => Promise<[Buffer]>;
          delete: (options?: unknown) => Promise<unknown>;
        };
      };
    })();
  }
  return gcsBucketPromise;
}

/**
 * Transitional adapter:
 * current attachment schema stores encrypted payload inline in DB.
 * GCS object I/O integration will be added behind this adapter next.
 */
export const gcsBlobStore: AttachmentBlobStore = {
  backend: BLOB_STORAGE.GCS,
  validateConfig() {
    loadCloudBlobConfig(BLOB_STORAGE.GCS);
  },
  async putObject(data, context) {
    const key = buildObjectKey(context);
    const bucket = await getGcsBucket();
    const file = bucket.file(key);
    await file.save(Buffer.from(data), {
      resumable: false,
      contentType: "application/octet-stream",
    });
    return encodeObjectRef({ key });
  },
  async getObject(stored, context) {
    const ref = decodeObjectRef(stored);
    const key = ref?.key ?? buildObjectKey(context);
    const bucket = await getGcsBucket();
    const file = bucket.file(key);
    const [buffer] = await file.download();
    return buffer;
  },
  async deleteObject(stored, context) {
    const ref = decodeObjectRef(stored);
    const key = ref?.key ?? buildObjectKey(context);
    const bucket = await getGcsBucket();
    const file = bucket.file(key);
    await file.delete({ ignoreNotFound: true });
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
