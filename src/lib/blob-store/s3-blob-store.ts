import {
  BLOB_STORAGE,
  type AttachmentBlobStore,
  type BlobObjectListing,
} from "@/lib/blob-store/types";
import { loadCloudBlobConfig } from "@/lib/blob-store/config";
import {
  BLOB_CONTENT_TYPE,
} from "@/lib/blob-store/constants";
import { blobMarkerKey, buildObjectKey, encodeObjectRef, resolveObjectRefKey } from "@/lib/blob-store/object-ref";
import { createdUnlessExists, HTTP_PRECONDITION_FAILED, nullIfNotFound } from "@/lib/blob-store/errors";
import { streamBodyToBuffer } from "@/lib/blob-store/stream";
import { requireOptionalModule } from "@/lib/blob-store/runtime-module";

// The @aws-sdk/client-s3 surface this store uses. Each is a library value's
// shape, registered in check-bypass-rls's EXTERNAL_SHAPE_ALLOWLIST with its
// supplying package.
type S3SendClient = { send: (command: unknown) => Promise<unknown> };
type S3Module = {
  S3Client: new (options: { region: string; forcePathStyle: boolean }) => unknown;
  PutObjectCommand: new (input: unknown) => unknown;
  GetObjectCommand: new (input: unknown) => unknown;
  DeleteObjectCommand: new (input: unknown) => unknown;
  ListObjectsV2Command: new (input: unknown) => unknown;
};

let s3ClientPromise: Promise<{
  client: S3SendClient;
  PutObjectCommand: new (input: unknown) => unknown;
  GetObjectCommand: new (input: unknown) => unknown;
  DeleteObjectCommand: new (input: unknown) => unknown;
  ListObjectsV2Command: new (input: unknown) => unknown;
}> | null = null;

async function getS3Client({ region, forcePathStyle }: { region: string; forcePathStyle: boolean }) {
  if (!s3ClientPromise) {
    s3ClientPromise = (async () => {
      const moduleName = "@aws-sdk/client-s3";
      const mod = requireOptionalModule<Record<string, unknown>>(moduleName) as S3Module;
      return {
        client: new mod.S3Client({ region, forcePathStyle }) as S3SendClient,
        PutObjectCommand: mod.PutObjectCommand as new (input: unknown) => unknown,
        GetObjectCommand: mod.GetObjectCommand as new (input: unknown) => unknown,
        DeleteObjectCommand: mod.DeleteObjectCommand as new (input: unknown) => unknown,
        ListObjectsV2Command: mod.ListObjectsV2Command as new (input: unknown) => unknown,
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
    const config = loadCloudBlobConfig(BLOB_STORAGE.S3);
    const key = buildObjectKey(context);
    // Encoded before the upload: a key whose ref would exceed
    // MAX_OBJECT_REF_BYTES is refused here instead of leaving an object no row
    // can name.
    const ref = encodeObjectRef({ key });
    const { client, PutObjectCommand } = await getS3Client(config);

    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: Buffer.from(data),
        ContentType: BLOB_CONTENT_TYPE.OCTET_STREAM,
      }),
    );

    return ref;
  },
  async getObject(stored, context) {
    const config = loadCloudBlobConfig(BLOB_STORAGE.S3);
    const key = resolveObjectRefKey(stored, context);
    const { client, GetObjectCommand } = await getS3Client(config);

    const response = await client.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }),
    );

    const body = (response as { Body?: unknown }).Body;
    return streamBodyToBuffer(body);
  },
  async deleteObject(stored, context) {
    const config = loadCloudBlobConfig(BLOB_STORAGE.S3);
    const key = resolveObjectRefKey(stored, context);
    const { client, DeleteObjectCommand } = await getS3Client(config);

    await client.send(
      new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }),
    );
  },
  async listObjects(prefix, { cursor, pageSize }) {
    const config = loadCloudBlobConfig(BLOB_STORAGE.S3);
    const { client, ListObjectsV2Command } = await getS3Client(config);
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix,
        MaxKeys: pageSize,
        ...(cursor ? { ContinuationToken: cursor } : {}),
      }),
    );
    // ListObjectsV2CommandOutput's fields this reads (s3-blob-store.test.ts
    // types its fixtures against the SDK output type).
    const page = response as {
      Contents?: { Key?: string; LastModified?: Date }[];
      IsTruncated?: boolean;
      NextContinuationToken?: string;
    };
    const objects: BlobObjectListing[] = [];
    for (const item of page.Contents ?? []) {
      if (item.Key && item.LastModified) objects.push({ key: item.Key, lastModified: item.LastModified });
    }
    const next = page.IsTruncated ? page.NextContinuationToken : undefined;
    return next ? { objects, cursor: next } : { objects };
  },
  async readMarker() {
    const config = loadCloudBlobConfig(BLOB_STORAGE.S3);
    const { client, GetObjectCommand } = await getS3Client(config);
    return nullIfNotFound(async () => {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: blobMarkerKey() }));
      return (await streamBodyToBuffer((response as { Body?: unknown }).Body)).toString("utf8");
    });
  },
  async createMarker(body) {
    const config = loadCloudBlobConfig(BLOB_STORAGE.S3);
    const { client, PutObjectCommand } = await getS3Client(config);
    return createdUnlessExists(
      () =>
        client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: blobMarkerKey(),
            Body: Buffer.from(body, "utf8"),
            ContentType: BLOB_CONTENT_TYPE.TEXT_PLAIN,
            // Conditional create: the store refuses (412) when the key exists.
            IfNoneMatch: "*",
          }),
        ),
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
