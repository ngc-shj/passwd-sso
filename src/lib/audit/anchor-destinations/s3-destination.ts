import { S3Client, PutObjectCommand, type S3ClientConfig } from "@aws-sdk/client-s3";
import { AUDIT_ANCHOR_RETENTION_YEARS } from "@/lib/constants/audit/audit";
import { MS_PER_DAY, MS_PER_SECOND } from "@/lib/constants/time";
import type { AnchorDestination } from "./destination";

// Per-request bounds; the caller's abort signal bounds the upload as a whole.
const S3_CONNECTION_TIMEOUT_MS = 5 * MS_PER_SECOND;
const S3_REQUEST_TIMEOUT_MS = 30 * MS_PER_SECOND;

export type S3DestinationClientOptions = Pick<
  S3ClientConfig,
  "endpoint" | "forcePathStyle" | "credentials" | "region"
>;

type S3Config = {
  bucket: string;
  prefix: string;
  retentionYears?: number;
  clientOptions?: S3DestinationClientOptions;
};

/** The object key an artifact is stored under: the prefix joined with one `/`. */
export function joinS3Key(prefix: string, artifactKey: string): string {
  return prefix ? `${prefix}/${artifactKey}` : artifactKey;
}

export class S3Destination implements AnchorDestination {
  readonly name = "s3-object-lock";

  private readonly bucket: string;
  private readonly prefix: string;
  private readonly retentionYears: number;
  private readonly client: S3Client;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.prefix = config.prefix;
    this.retentionYears = config.retentionYears ?? AUDIT_ANCHOR_RETENTION_YEARS;
    this.client = new S3Client({
      ...(config.clientOptions ?? {}),
      requestHandler: {
        connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
        requestTimeout: S3_REQUEST_TIMEOUT_MS,
        throwOnRequestTimeout: true,
      },
    });
  }

  async upload(args: {
    artifactBytes: Buffer;
    artifactKey: string;
    contentType: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const { artifactBytes, artifactKey, contentType, signal } = args;

    const retainUntil = new Date(
      Date.now() + this.retentionYears * 365 * MS_PER_DAY,
    );

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: joinS3Key(this.prefix, artifactKey),
        Body: artifactBytes,
        ContentType: contentType,
        // The anchors bucket policy denies any PutObject whose
        // s3:object-lock-mode is not COMPLIANCE — including one that omits the
        // header — so this must always be sent.
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: retainUntil,
        ServerSideEncryption: "AES256",
      }),
      { abortSignal: signal },
    );
  }
}
