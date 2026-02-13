import { dbBlobStore } from "@/lib/blob-store/db-blob-store";
import type { AttachmentBlobStore, BlobBackend } from "@/lib/blob-store/types";

export function resolveBlobBackend(): BlobBackend {
  const raw = process.env.BLOB_BACKEND?.trim().toLowerCase();
  if (!raw || raw === "db") return "db";
  if (raw === "s3" || raw === "azure" || raw === "gcs") return raw;
  return "db";
}

export function getAttachmentBlobStore(): AttachmentBlobStore {
  const backend = resolveBlobBackend();
  if (backend === "db") return dbBlobStore;
  return dbBlobStore;
}

export type { AttachmentBlobStore, BlobBackend } from "@/lib/blob-store/types";
