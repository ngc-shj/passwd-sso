import {
  BLOB_STORAGE,
  type AttachmentBlobStore,
  type BlobObjectListing,
} from "@/lib/blob-store/types";
import { loadCloudBlobConfig } from "@/lib/blob-store/config";
import { BLOB_CONTENT_TYPE } from "@/lib/blob-store/constants";
import { blobMarkerKey, buildObjectKey, encodeObjectRef, resolveObjectRefKey } from "@/lib/blob-store/object-ref";
import { createdUnlessExists, HTTP_PRECONDITION_FAILED, nullIfNotFound } from "@/lib/blob-store/errors";
import { requireOptionalModule } from "@/lib/blob-store/runtime-module";

// The @google-cloud/storage surface this store uses. Each is a library value's
// shape, registered in check-bypass-rls's EXTERNAL_SHAPE_ALLOWLIST with its
// supplying package.
type GcsBucket = {
  file: (key: string) => {
    save: (data: Buffer, options?: unknown) => Promise<unknown>;
    download: () => Promise<[Buffer]>;
    delete: (options?: unknown) => Promise<unknown>;
  };
  getFiles: (query: {
    prefix: string;
    autoPaginate: false;
    maxResults: number;
    pageToken?: string;
  }) => Promise<[{ name: string; metadata: { updated?: string } }[], { pageToken?: string } | null | undefined, unknown]>;
};
type GcsModule = {
  Storage: new () => {
    bucket: (bucketName: string) => unknown;
  };
};

let gcsBucketPromise: Promise<GcsBucket> | null = null;

async function getGcsBucket() {
  if (!gcsBucketPromise) {
    gcsBucketPromise = (async () => {
      const moduleName = "@google-cloud/storage";
      const mod = requireOptionalModule<Record<string, unknown>>(moduleName) as GcsModule;
      const { bucket } = loadCloudBlobConfig(BLOB_STORAGE.GCS);
      const storage = new mod.Storage();
      return storage.bucket(bucket) as GcsBucket;
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
    // Encoded before the upload, as in the S3 store.
    const ref = encodeObjectRef({ key });
    const bucket = await getGcsBucket();
    const file = bucket.file(key);
    await file.save(Buffer.from(data), {
      resumable: false,
      contentType: BLOB_CONTENT_TYPE.OCTET_STREAM,
    });
    return ref;
  },
  async getObject(stored, context) {
    const key = resolveObjectRefKey(stored, context);
    const bucket = await getGcsBucket();
    const file = bucket.file(key);
    const [buffer] = await file.download();
    return buffer;
  },
  async deleteObject(stored, context) {
    const key = resolveObjectRefKey(stored, context);
    const bucket = await getGcsBucket();
    const file = bucket.file(key);
    await file.delete({ ignoreNotFound: true });
  },
  async listObjects(prefix, { cursor, pageSize }) {
    const bucket = await getGcsBucket();
    const [files, nextQuery] = await bucket.getFiles({
      prefix,
      autoPaginate: false,
      maxResults: pageSize,
      ...(cursor ? { pageToken: cursor } : {}),
    });
    const objects: BlobObjectListing[] = [];
    for (const file of files) {
      // `updated` is an RFC 3339 string; an object without one is not listed,
      // so the sweep never treats an unknown age as old.
      const lastModified = file.metadata.updated ? new Date(file.metadata.updated) : null;
      if (lastModified && !Number.isNaN(lastModified.getTime())) objects.push({ key: file.name, lastModified });
    }
    const next = nextQuery?.pageToken;
    return next ? { objects, cursor: next } : { objects };
  },
  async readMarker() {
    const bucket = await getGcsBucket();
    return nullIfNotFound(async () => {
      const [buffer] = await bucket.file(blobMarkerKey()).download();
      return buffer.toString("utf8");
    });
  },
  async createMarker(body) {
    const bucket = await getGcsBucket();
    return createdUnlessExists(
      () =>
        bucket.file(blobMarkerKey()).save(Buffer.from(body, "utf8"), {
          resumable: false,
          contentType: BLOB_CONTENT_TYPE.TEXT_PLAIN,
          // Conditional create: generation 0 matches only an absent object.
          preconditionOpts: { ifGenerationMatch: 0 },
        }),
      [HTTP_PRECONDITION_FAILED],
    );
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
