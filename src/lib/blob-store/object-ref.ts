import { randomBytes } from "node:crypto";
import type { AttachmentBlobContext, AttachmentBlobPutContext } from "@/lib/blob-store/types";
import { BLOB_OBJECT_SCOPE } from "@/lib/blob-store/constants";

export interface BlobObjectRef {
  key: string;
}

/**
 * A stored external-backend ref that does not decode, or names an object
 * other than the row's own. Carries no ref content; routes answer 409
 * BLOB_REF_INVALID.
 */
export class BlobRefInvalidError extends Error {
  constructor() {
    super("BLOB_REF_INVALID");
    this.name = "BlobRefInvalidError";
  }
}

const GENERATION_RE = /^[0-9a-f]{32}$/;
const OBJECT_SUFFIX = ".bin";

/** A fresh object-key generation: 128 bits from the server CSPRNG, lowercase hex. */
export function newBlobGeneration(): string {
  return randomBytes(16).toString("hex");
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

function scopeSegments(context: AttachmentBlobContext): string[] {
  return context.teamId
    ? [BLOB_OBJECT_SCOPE.TEAM, context.teamId]
    : [BLOB_OBJECT_SCOPE.PERSONAL];
}

/**
 * The key prefix objects are written under: BLOB_OBJECT_PREFIX with one
 * trailing `/`, or "" when unset (no leading `/` at the bucket root).
 */
export function objectKeyPrefix(): string {
  const rawPrefix = process.env.BLOB_OBJECT_PREFIX?.trim() ?? "";
  return rawPrefix ? `${rawPrefix.replace(/\/+$/, "")}/` : "";
}

export function buildObjectKey(context: AttachmentBlobPutContext): string {
  if (!GENERATION_RE.test(context.generation)) {
    throw new Error("Blob object generation must be 32 lowercase hex characters");
  }
  const scope = scopeSegments(context).join("/");
  return `${objectKeyPrefix()}${scope}/${context.entryId}/${context.attachmentId}/${context.generation}${OBJECT_SUFFIX}`;
}

const MARKER_NAME = ".passwd-sso-deployment";

/**
 * The deployment-ownership marker's key under the current prefix. The orphan
 * sweep deletes nothing unless this object's body equals DEPLOYMENT_ID.
 */
export function blobMarkerKey(): string {
  return `${objectKeyPrefix()}${MARKER_NAME}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ParsedObjectKey {
  scope: (typeof BLOB_OBJECT_SCOPE)[keyof typeof BLOB_OBJECT_SCOPE];
  teamId?: string;
  entryId: string;
  /** Lowercased, so it compares equal to the uuid column it is looked up by. */
  attachmentId: string;
  generation?: string;
}

/**
 * The inverse of buildObjectKey, for keys under the CURRENT prefix only:
 *
 *   <prefix>team/<teamId>/<entryId>/<attachmentId>[/<generation>].bin
 *   <prefix>personal/<entryId>/<attachmentId>[/<generation>].bin
 *
 * Every id segment must be UUID syntax and a generation 32 lowercase hex.
 * Anything else (another prefix, an extra or missing segment, the marker)
 * is null: the orphan sweep never deletes what it cannot attribute to a row.
 */
export function parseObjectKey(key: string): ParsedObjectKey | null {
  const prefix = objectKeyPrefix();
  if (!key.startsWith(prefix)) return null;
  const segments = key.slice(prefix.length).split("/");
  const [scope, ...rest] = segments;
  let teamId: string | undefined;
  let ids: string[];
  if (scope === BLOB_OBJECT_SCOPE.TEAM) {
    [teamId, ...ids] = rest;
    if (teamId === undefined || !UUID_RE.test(teamId)) return null;
  } else if (scope === BLOB_OBJECT_SCOPE.PERSONAL) {
    ids = rest;
  } else {
    return null;
  }
  if (ids.length !== 2 && ids.length !== 3) return null;
  const last = stripSuffix(ids[ids.length - 1]);
  if (last === null) return null;
  const [entryId, attachmentId, generation] = ids.length === 3 ? [ids[0], ids[1], last] : [ids[0], last, undefined];
  if (!UUID_RE.test(entryId) || !UUID_RE.test(attachmentId)) return null;
  if (generation !== undefined && !GENERATION_RE.test(generation)) return null;
  return {
    scope,
    ...(teamId !== undefined ? { teamId } : {}),
    entryId,
    attachmentId: attachmentId.toLowerCase(),
    ...(generation !== undefined ? { generation } : {}),
  };
}

function sameId(segment: string, id: string): boolean {
  return segment.toLowerCase() === id.toLowerCase();
}

function stripSuffix(segment: string): string | null {
  return segment.endsWith(OBJECT_SUFFIX) ? segment.slice(0, -OBJECT_SUFFIX.length) : null;
}

/**
 * Whether `key` names an object of the row described by `context`. Accepted,
 * anchored segment-wise from the end:
 *
 *   <prefix>team/<teamId>/<entryId>/<attachmentId>.bin               (legacy)
 *   <prefix>team/<teamId>/<entryId>/<attachmentId>/<generation>.bin
 *   <prefix>personal/<entryId>/<attachmentId>.bin                    (legacy)
 *   <prefix>personal/<entryId>/<attachmentId>/<generation>.bin
 *
 * Every id must equal the row's own (case-insensitive); the scope/id/generation
 * tail holds no `..`, no percent-encoding and no empty segment. The prefix is
 * accepted whole when free of `..` (it is deployment config and may have
 * changed since the object was written).
 */
export function validateObjectRefKey(key: string, context: AttachmentBlobContext): boolean {
  const segments = key.split("/");
  const scope = scopeSegments(context);

  const tailMatches = (tail: string[], generationForm: boolean): boolean => {
    if (tail.some((s) => s.length === 0 || s.includes("..") || s.includes("%"))) return false;
    for (let i = 0; i < scope.length; i++) {
      // The scope literal is exact; the team id compares case-insensitively.
      if (i === 0 ? tail[i] !== scope[i] : !sameId(tail[i], scope[i])) return false;
    }
    const rest = tail.slice(scope.length);
    if (!sameId(rest[0], context.entryId)) return false;
    if (generationForm) {
      const generation = stripSuffix(rest[2]);
      return sameId(rest[1], context.attachmentId) && generation !== null && GENERATION_RE.test(generation);
    }
    const attachmentId = stripSuffix(rest[1]);
    return attachmentId !== null && sameId(attachmentId, context.attachmentId);
  };

  for (const generationForm of [false, true]) {
    const tailLength = scope.length + (generationForm ? 3 : 2);
    if (segments.length < tailLength) continue;
    const prefix = segments.slice(0, segments.length - tailLength).join("/");
    if (prefix.includes("..")) continue;
    if (tailMatches(segments.slice(segments.length - tailLength), generationForm)) return true;
  }
  return false;
}

/**
 * The object key a stored external-backend ref names, refusing (fail closed,
 * no fallback to a computed key) a ref that does not decode or does not name
 * the row's own object.
 */
export function resolveObjectRefKey(stored: Uint8Array, context: AttachmentBlobContext): string {
  const ref = decodeObjectRef(stored);
  if (!ref || !validateObjectRefKey(ref.key, context)) throw new BlobRefInvalidError();
  return ref.key;
}
