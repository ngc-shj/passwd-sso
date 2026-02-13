import { dbBlobStore } from "@/lib/blob-store/db-blob-store";
import {
  BLOB_STORAGE,
  type AttachmentBlobStore,
  type BlobBackend,
} from "@/lib/blob-store/types";

export function resolveBlobBackend(): BlobBackend {
  const raw = process.env.BLOB_BACKEND?.trim().toLowerCase();
  if (!raw) return BLOB_STORAGE.DB;
  if (raw === BLOB_STORAGE.S3) return BLOB_STORAGE.S3;
  if (raw === BLOB_STORAGE.AZURE) return BLOB_STORAGE.AZURE;
  if (raw === BLOB_STORAGE.GCS) return BLOB_STORAGE.GCS;
  return BLOB_STORAGE.DB;
}

export function getAttachmentBlobStore(): AttachmentBlobStore {
  const backend = resolveBlobBackend();
  if (backend === BLOB_STORAGE.DB) return dbBlobStore;
  return dbBlobStore;
}

export {
  BLOB_STORAGE,
  type AttachmentBlobStore,
  type BlobBackend,
} from "@/lib/blob-store/types";
