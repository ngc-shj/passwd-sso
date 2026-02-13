import type { AttachmentBlobContext } from "@/lib/blob-store/types";
import { BLOB_OBJECT_SCOPE } from "@/lib/blob-store/constants";

export interface BlobObjectRef {
  key: string;
}

export function encodeObjectRef(ref: BlobObjectRef): Uint8Array {
  return Buffer.from(JSON.stringify(ref), "utf8");
}

export function decodeObjectRef(stored: Uint8Array): BlobObjectRef | null {
  try {
    const parsed = JSON.parse(Buffer.from(stored).toString("utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.key === "string" &&
      parsed.key.length > 0
    ) {
      return { key: parsed.key };
    }
    return null;
  } catch {
    return null;
  }
}

export function buildObjectKey(context: AttachmentBlobContext): string {
  const rawPrefix = process.env.BLOB_OBJECT_PREFIX?.trim() ?? "";
  const prefix = rawPrefix ? `${rawPrefix.replace(/\/+$/, "")}/` : "";
  const scope = context.orgId
    ? `${BLOB_OBJECT_SCOPE.ORG}/${context.orgId}`
    : BLOB_OBJECT_SCOPE.PERSONAL;
  return `${prefix}${scope}/${context.entryId}/${context.attachmentId}.bin`;
}
