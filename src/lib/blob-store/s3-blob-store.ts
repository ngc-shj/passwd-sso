import {
  BLOB_STORAGE,
  type AttachmentBlobStore,
} from "@/lib/blob-store/types";
import { loadCloudBlobConfig } from "@/lib/blob-store/config";
import {
  BLOB_CONTENT_TYPE,
} from "@/lib/blob-store/constants";
import { buildObjectKey, decodeObjectRef, encodeObjectRef } from "@/lib/blob-store/object-ref";
import { streamBodyToBuffer } from "@/lib/blob-store/stream";
import { requireOptionalModule } from "@/lib/blob-store/runtime-module";

// The @aws-sdk/client-s3 surface this store uses. Each is a library value's
// shape, registered in check-bypass-rls's EXTERNAL_SHAPE_ALLOWLIST with its
// supplying package.
type S3SendClient = { send: (command: unknown) => Promise<unknown> };
type S3Module = {
  S3Client: new (options: { region: string }) => unknown;
  PutObjectCommand: new (input: unknown) => unknown;
  GetObjectCommand: new (input: unknown) => unknown;
  DeleteObjectCommand: new (input: unknown) => unknown;
};

let s3ClientPromise: Promise<{
  client: S3SendClient;
  PutObjectCommand: new (input: unknown) => unknown;
  GetObjectCommand: new (input: unknown) => unknown;
  DeleteObjectCommand: new (input: unknown) => unknown;
}> | null = null;

async function getS3Client(region: string) {
  if (!s3ClientPromise) {
    s3ClientPromise = (async () => {
      const moduleName = "@aws-sdk/client-s3";
      const mod = requireOptionalModule<Record<string, unknown>>(moduleName) as S3Module;
      return {
        client: new mod.S3Client({ region }) as S3SendClient,
        PutObjectCommand: mod.PutObjectCommand as new (input: unknown) => unknown,
        GetObjectCommand: mod.GetObjectCommand as new (input: unknown) => unknown,
        DeleteObjectCommand: mod.DeleteObjectCommand as new (input: unknown) => unknown,
      };
    })();
  }
  return s3ClientPromise;
}

/**
 * Transitional adapter:
 * current attachment schema stores encrypted payload inline in DB.
 * S3 object I/O integration will be added behind this adapter next.
 */
export const s3BlobStore: AttachmentBlobStore = {
  backend: BLOB_STORAGE.S3,
  validateConfig() {
    loadCloudBlobConfig(BLOB_STORAGE.S3);
  },
  async putObject(data, context) {
    const { bucket, region } = loadCloudBlobConfig(BLOB_STORAGE.S3);
    const key = buildObjectKey(context);
    const { client, PutObjectCommand } = await getS3Client(region);

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Buffer.from(data),
        ContentType: BLOB_CONTENT_TYPE.OCTET_STREAM,
      }),
    );

    return encodeObjectRef({ key });
  },
  async getObject(stored, context) {
    const { bucket, region } = loadCloudBlobConfig(BLOB_STORAGE.S3);
    const ref = decodeObjectRef(stored);
    const key = ref?.key ?? buildObjectKey(context);
    const { client, GetObjectCommand } = await getS3Client(region);

    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );

    const body = (response as { Body?: unknown }).Body;
    return streamBodyToBuffer(body);
  },
  async deleteObject(stored, context) {
    const { bucket, region } = loadCloudBlobConfig(BLOB_STORAGE.S3);
    const ref = decodeObjectRef(stored);
    const key = ref?.key ?? buildObjectKey(context);
    const { client, DeleteObjectCommand } = await getS3Client(region);

    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
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
