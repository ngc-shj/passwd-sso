import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { AUDIT_ANCHOR_RETENTION_YEARS } from "@/lib/constants/audit/audit";
import { MS_PER_DAY, MS_PER_SECOND } from "@/lib/constants/time";
import { assertAnchorArtifactKey } from "@/lib/audit/anchor-artifact-keys";
import { assertArtifactSize, type AnchorDestination } from "./destination";

// Per-request bounds; the caller's abort signal bounds the run as a whole.
const S3_CONNECTION_TIMEOUT_MS = 5 * MS_PER_SECOND;
const S3_REQUEST_TIMEOUT_MS = 30 * MS_PER_SECOND;

const HTTP_PRECONDITION_FAILED = 412;
const HTTP_CONFLICT = 409;
// 409 ConditionalRequestConflict: a concurrent write to the key was in
// flight. S3 asks for a retry; the retry's answer (412 or success) decides.
const S3_CONFLICT_RETRIES = 2;

export type S3DestinationClientOptions = Pick<
  S3ClientConfig,
  "endpoint" | "forcePathStyle" | "credentials" | "region"
>;

type S3Config = {
  bucket: string;
  prefix: string;
  retentionYears?: number;
  clientOptions?: S3DestinationClientOptions;
  /** Keys per listing page. Default: the API's. */
  listPageSize?: number;
};

/** The object key an artifact is stored under: the prefix joined with one `/`. */
export function joinS3Key(prefix: string, artifactKey: string): string {
  return prefix ? `${prefix}/${artifactKey}` : artifactKey;
}

/**
 * The `Prefix` every listing is made under. The publisher role's
 * `s3:ListBucket` grant is conditioned on it, and an existence check lists
 * under a key that starts with it.
 */
export function s3ListPrefix(prefix: string): string {
  return joinS3Key(prefix, "");
}

function httpStatusOf(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;
}

export class S3Destination implements AnchorDestination {
  readonly name = "s3-object-lock";

  private readonly bucket: string;
  private readonly prefix: string;
  private readonly retentionYears: number;
  private readonly listPageSize: number | undefined;
  private readonly client: S3Client;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.prefix = config.prefix;
    this.retentionYears = config.retentionYears ?? AUDIT_ANCHOR_RETENTION_YEARS;
    this.listPageSize = config.listPageSize;
    this.client = new S3Client({
      ...(config.clientOptions ?? {}),
      requestHandler: {
        connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
        requestTimeout: S3_REQUEST_TIMEOUT_MS,
        throwOnRequestTimeout: true,
      },
    });
  }

  async create(args: {
    artifactBytes: Buffer;
    artifactKey: string;
    contentType: string;
    signal?: AbortSignal;
  }): Promise<"created" | "exists"> {
    const { artifactBytes, artifactKey, contentType, signal } = args;
    assertAnchorArtifactKey(artifactKey);
    assertArtifactSize(artifactBytes.length);

    const retainUntil = new Date(
      Date.now() + this.retentionYears * 365 * MS_PER_DAY,
    );

    for (let conflicts = 0; ; conflicts++) {
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: joinS3Key(this.prefix, artifactKey),
            Body: artifactBytes,
            ContentType: contentType,
            // Create-only: the PUT succeeds only while no object holds the key.
            IfNoneMatch: "*",
            // The anchors bucket policy denies any PutObject whose
            // s3:object-lock-mode is not COMPLIANCE — including one that omits the
            // header — so this must always be sent.
            ObjectLockMode: "COMPLIANCE",
            ObjectLockRetainUntilDate: retainUntil,
            ServerSideEncryption: "AES256",
          }),
          { abortSignal: signal },
        );
        return "created";
      } catch (err) {
        const status = httpStatusOf(err);
        if (status === HTTP_PRECONDITION_FAILED) return "exists";
        if (status === HTTP_CONFLICT && conflicts < S3_CONFLICT_RETRIES) continue;
        throw err;
      }
    }
  }

  async read(artifactKey: string, signal?: AbortSignal): Promise<Buffer | null> {
    assertAnchorArtifactKey(artifactKey);
    const key = joinS3Key(this.prefix, artifactKey);

    // Absence is read from a listing, never from the GET's status: without
    // s3:ListBucket a missing key answers 403, the same as a denied one. The
    // key itself sorts first among the keys it prefixes.
    const listed = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: key, MaxKeys: 1 }),
      { abortSignal: signal },
    );
    if (listed.Contents?.[0]?.Key !== key) return null;

    const got = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: signal },
    );
    if (got.ContentLength !== undefined) assertArtifactSize(got.ContentLength);
    if (!got.Body) throw new Error("S3Destination: GetObject returned no body");
    const bytes = Buffer.from(await got.Body.transformToByteArray());
    assertArtifactSize(bytes.length);
    return bytes;
  }

  async list(signal?: AbortSignal): Promise<string[]> {
    const listPrefix = s3ListPrefix(this.prefix);
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: listPrefix,
          MaxKeys: this.listPageSize,
          ContinuationToken: continuationToken,
        }),
        { abortSignal: signal },
      );
      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined) keys.push(object.Key.slice(listPrefix.length));
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    return keys;
  }
}
