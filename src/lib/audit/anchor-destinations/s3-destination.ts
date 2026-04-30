import { requireOptionalModule } from "@/lib/blob-store/runtime-module";
import { AUDIT_ANCHOR_RETENTION_YEARS } from "@/lib/constants/audit/audit";
import type { AnchorDestination } from "./destination";

type S3Module = {
  S3Client: new (options: { region?: string }) => { send: (command: unknown) => Promise<unknown> };
  PutObjectCommand: new (input: unknown) => unknown;
};

type S3Config = {
  bucket: string;
  prefix: string;
  retentionYears?: number;
};

export class S3Destination implements AnchorDestination {
  readonly name = "s3-object-lock";

  private readonly bucket: string;
  private readonly prefix: string;
  private readonly retentionYears: number;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.prefix = config.prefix;
    this.retentionYears = config.retentionYears ?? AUDIT_ANCHOR_RETENTION_YEARS;
  }

  async upload(args: {
    artifactBytes: Buffer;
    artifactKey: string;
    contentType: string;
  }): Promise<void> {
    const { artifactBytes, artifactKey, contentType } = args;

    const mod = requireOptionalModule<S3Module>("@aws-sdk/client-s3");
    const client = new mod.S3Client({});

    const retainUntil = new Date(
      Date.now() + this.retentionYears * 365 * 24 * 60 * 60 * 1000,
    );

    const key = this.prefix ? `${this.prefix}/${artifactKey}` : artifactKey;

    await client.send(
      new mod.PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: artifactBytes,
        ContentType: contentType,
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: retainUntil,
      }),
    );
  }
}
