import { dbBlobStore } from "@/lib/blob-store/db-blob-store";
import type { AttachmentBlobStore, BlobBackend } from "@/lib/blob-store/types";

function resolveBackend(): BlobBackend {
  const raw = process.env.BLOB_BACKEND?.trim().toLowerCase();
  if (!raw || raw === "db") return "db";
  return "db";
}

export function getAttachmentBlobStore(): AttachmentBlobStore {
  const backend = resolveBackend();
  if (backend === "db") return dbBlobStore;
  return dbBlobStore;
}

export type { AttachmentBlobStore, BlobBackend } from "@/lib/blob-store/types";

