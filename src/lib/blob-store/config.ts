import { BLOB_STORAGE, type BlobBackend } from "@/lib/blob-store/types";

export interface S3BlobConfig {
  backend: typeof BLOB_STORAGE.S3;
  region: string;
  bucket: string;
}

export interface AzureBlobConfig {
  backend: typeof BLOB_STORAGE.AZURE;
  account: string;
  container: string;
}

export interface GcsBlobConfig {
  backend: typeof BLOB_STORAGE.GCS;
  bucket: string;
}

export type CloudBlobConfig = S3BlobConfig | AzureBlobConfig | GcsBlobConfig;

export function loadCloudBlobConfig(backend: BlobBackend): CloudBlobConfig {
  if (backend === BLOB_STORAGE.S3) {
    const region = process.env.AWS_REGION?.trim();
    const bucket = process.env.S3_ATTACHMENTS_BUCKET?.trim();
    if (!region || !bucket) {
      throw new Error(
        "S3 backend requires AWS_REGION and S3_ATTACHMENTS_BUCKET",
      );
    }
    return { backend, region, bucket };
  }

  if (backend === BLOB_STORAGE.AZURE) {
    const account = process.env.AZURE_STORAGE_ACCOUNT?.trim();
    const container = process.env.AZURE_BLOB_CONTAINER?.trim();
    if (!account || !container) {
      throw new Error(
        "Azure backend requires AZURE_STORAGE_ACCOUNT and AZURE_BLOB_CONTAINER",
      );
    }
    return { backend, account, container };
  }

  if (backend === BLOB_STORAGE.GCS) {
    const bucket = process.env.GCS_ATTACHMENTS_BUCKET?.trim();
    if (!bucket) {
      throw new Error("GCS backend requires GCS_ATTACHMENTS_BUCKET");
    }
    return { backend, bucket };
  }

  throw new Error("Cloud blob config requested for non-cloud backend");
}

