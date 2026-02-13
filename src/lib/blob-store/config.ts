import { BLOB_STORAGE, type BlobBackend } from "@/lib/blob-store/types";
import { BLOB_CONFIG_ERROR } from "@/lib/blob-store/constants";

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

export function loadCloudBlobConfig(
  backend: typeof BLOB_STORAGE.S3,
): S3BlobConfig;
export function loadCloudBlobConfig(
  backend: typeof BLOB_STORAGE.AZURE,
): AzureBlobConfig;
export function loadCloudBlobConfig(
  backend: typeof BLOB_STORAGE.GCS,
): GcsBlobConfig;
export function loadCloudBlobConfig(backend: BlobBackend): CloudBlobConfig;
export function loadCloudBlobConfig(backend: BlobBackend): CloudBlobConfig {
  if (backend === BLOB_STORAGE.S3) {
    const region = process.env.AWS_REGION?.trim();
    const bucket = process.env.S3_ATTACHMENTS_BUCKET?.trim();
    if (!region || !bucket) {
      throw new Error(BLOB_CONFIG_ERROR.S3_REQUIRED);
    }
    return { backend, region, bucket };
  }

  if (backend === BLOB_STORAGE.AZURE) {
    const account = process.env.AZURE_STORAGE_ACCOUNT?.trim();
    const container = process.env.AZURE_BLOB_CONTAINER?.trim();
    if (!account || !container) {
      throw new Error(BLOB_CONFIG_ERROR.AZURE_REQUIRED);
    }
    return { backend, account, container };
  }

  if (backend === BLOB_STORAGE.GCS) {
    const bucket = process.env.GCS_ATTACHMENTS_BUCKET?.trim();
    if (!bucket) {
      throw new Error(BLOB_CONFIG_ERROR.GCS_REQUIRED);
    }
    return { backend, bucket };
  }

  throw new Error(BLOB_CONFIG_ERROR.NON_CLOUD);
}
