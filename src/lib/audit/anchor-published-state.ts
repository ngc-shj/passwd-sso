import { createHash } from "node:crypto";
import { getLogger } from "@/lib/logger";
import {
  parseManifestArtifactKey,
  publicKeyArtifactKey,
} from "@/lib/audit/anchor-artifact-keys";
import {
  kidForPublicKey,
  parsePublicKeyHex,
  verify,
  type Manifest,
} from "@/lib/audit/anchor-manifest";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";

/**
 * What the primary destination holds, read from the destination itself: the
 * publisher decides from this, never from a database value.
 */

export type VerifiedManifest = {
  artifactKey: string;
  date: string;
  kid: string;
  bytes: Buffer;
  manifest: Manifest;
  /** Over the JWS payload bytes — what `previousManifest.sha256` names. */
  sha256: string;
};

export type PublishedState = {
  /** null only when no manifest key is stored. */
  latest: VerifiedManifest | null;
  /** Manifest keys on `latest`'s date. */
  latestDateKeyCount: number;
  /** Some manifest key's NAME carries the own kid; the object is not read. */
  ownKidHasPublished: boolean;
  /** `public-keys/<own kid>.pub` is listed and its content is the own key. */
  ownPublicKeyArchived: boolean;
  manifestKeys: string[];
};

/**
 * Public keys already resolved from the archive. Held by the caller, so it
 * lives as long as the publisher instance that owns it and no longer. Only a
 * resolved key is kept: a miss is looked up again, so archiving the key is
 * seen without a restart.
 */
export type AnchorKeyCache = {
  ownArchived: boolean;
  foreign: Map<string, Buffer>;
};

export function createAnchorKeyCache(): AnchorKeyCache {
  return { ownArchived: false, foreign: new Map() };
}

/** The reader's own key. Without `keyCache` every call reads the archive again. */
export type OwnKey = { publicKey: Buffer; keyCache?: AnchorKeyCache };

export const UNVERIFIABLE_DETAIL = {
  NOT_A_MANIFEST_KEY: "NOT_A_MANIFEST_KEY",
  OBJECT_MISSING: "OBJECT_MISSING",
  PUBLIC_KEY_NOT_ARCHIVED: "PUBLIC_KEY_NOT_ARCHIVED",
  PUBLIC_KEY_INVALID: "PUBLIC_KEY_INVALID",
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  DATE_MISMATCH: "DATE_MISMATCH",
} as const;

export type UnverifiableDetail = (typeof UNVERIFIABLE_DETAIL)[keyof typeof UNVERIFIABLE_DETAIL];

/**
 * A stored manifest object that is not a manifest its key's `kid` signed for
 * its key's date. Its `code` is what a failure reason carries; `detail` is for
 * the log, and names which clause failed.
 */
export class PublishedObjectUnverifiableError extends Error {
  readonly code = "PUBLISHED_OBJECT_UNVERIFIABLE";
  constructor(
    readonly artifactKey: string,
    readonly detail: UnverifiableDetail,
  ) {
    super("published anchor object is unverifiable");
    this.name = "PublishedObjectUnverifiableError";
  }
}

// The bucket policy's manifest pattern, `????-??-??.kid-*.jws`: what the
// publisher role may write. Wider than the keys `parseManifestArtifactKey` takes.
const MANIFEST_GLOB_RE = /^.{4}-.{2}-.{2}\.kid-.*\.jws$/s;

type ParsedManifestKey = { key: string; date: string; kid: string };

function parseManifestKeys(listedKeys: readonly string[]): ParsedManifestKey[] {
  const parsedKeys: ParsedManifestKey[] = [];
  for (const key of listedKeys) {
    const parsed = parseManifestArtifactKey(key);
    if (parsed) {
      parsedKeys.push({ key, ...parsed });
    } else if (MANIFEST_GLOB_RE.test(key)) {
      getLogger().warn(
        { artifactKey: key, _logType: "audit-anchor-publisher.unrecognised_manifest_key" },
        "audit-anchor-publisher.unrecognised_manifest_key",
      );
    }
  }
  return parsedKeys;
}

/** The archived key of a foreign `kid`, or the clause that kept it from resolving. */
async function resolveForeignKey(
  dest: AnchorDestination,
  kid: string,
  own: OwnKey,
  listedKeys: readonly string[],
  signal?: AbortSignal,
): Promise<Buffer | UnverifiableDetail> {
  const cached = own.keyCache?.foreign.get(kid);
  if (cached) return cached;

  const archiveKey = publicKeyArtifactKey(kid);
  if (!listedKeys.includes(archiveKey)) return UNVERIFIABLE_DETAIL.PUBLIC_KEY_NOT_ARCHIVED;
  const text = await dest.read(archiveKey, signal);
  if (text === null) return UNVERIFIABLE_DETAIL.PUBLIC_KEY_NOT_ARCHIVED;

  let publicKey: Buffer;
  try {
    publicKey = parsePublicKeyHex(text.toString("utf-8"));
  } catch {
    return UNVERIFIABLE_DETAIL.PUBLIC_KEY_INVALID;
  }
  if (kidForPublicKey(publicKey) !== kid) return UNVERIFIABLE_DETAIL.PUBLIC_KEY_INVALID;

  own.keyCache?.foreign.set(kid, publicKey);
  return publicKey;
}

/**
 * The manifest stored at `artifactKey`, verified: its key's `kid` is the own
 * one or resolves from the archive to a key of that `kid`; the signature
 * verifies under that key, which binds the header's `kid` to the key's; and
 * the key's date is the UTC date of `anchoredAt`. Anything else throws
 * PublishedObjectUnverifiableError. A destination error is thrown as it is.
 */
export async function readVerifiedManifest(
  dest: AnchorDestination,
  artifactKey: string,
  own: OwnKey,
  listedKeys: readonly string[],
  signal?: AbortSignal,
): Promise<VerifiedManifest> {
  const unverifiable = (detail: UnverifiableDetail) => new PublishedObjectUnverifiableError(artifactKey, detail);

  const parsed = parseManifestArtifactKey(artifactKey);
  if (!parsed) throw unverifiable(UNVERIFIABLE_DETAIL.NOT_A_MANIFEST_KEY);

  let publicKey = own.publicKey;
  if (parsed.kid !== kidForPublicKey(own.publicKey)) {
    const resolved = await resolveForeignKey(dest, parsed.kid, own, listedKeys, signal);
    if (!Buffer.isBuffer(resolved)) throw unverifiable(resolved);
    publicKey = resolved;
  }

  const bytes = await dest.read(artifactKey, signal);
  if (bytes === null) throw unverifiable(UNVERIFIABLE_DETAIL.OBJECT_MISSING);

  const jws = bytes.toString("utf-8");
  let manifest: Manifest;
  try {
    manifest = verify(jws, publicKey);
  } catch {
    throw unverifiable(UNVERIFIABLE_DETAIL.SIGNATURE_INVALID);
  }
  if (manifest.anchoredAt.slice(0, 10) !== parsed.date) throw unverifiable(UNVERIFIABLE_DETAIL.DATE_MISMATCH);

  const payload = Buffer.from(jws.split(".")[1] ?? "", "base64url");
  return {
    artifactKey,
    date: parsed.date,
    kid: parsed.kid,
    bytes,
    manifest,
    sha256: createHash("sha256").update(payload).digest("hex"),
  };
}

async function isOwnPublicKeyArchived(
  dest: AnchorDestination,
  own: OwnKey,
  listedKeys: readonly string[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (own.keyCache?.ownArchived) return true;
  const archiveKey = publicKeyArtifactKey(kidForPublicKey(own.publicKey));
  if (!listedKeys.includes(archiveKey)) return false;
  const text = await dest.read(archiveKey, signal);
  if (text === null) return false;
  let archived: Buffer;
  try {
    archived = parsePublicKeyHex(text.toString("utf-8"));
  } catch {
    return false;
  }
  if (!archived.equals(own.publicKey)) return false;
  if (own.keyCache) own.keyCache.ownArchived = true;
  return true;
}

/**
 * The published state for a listing already in hand. Reads one manifest —
 * the latest — and, until it has matched once, the own archived public key.
 * `latest` is, among the manifest keys on the greatest date, the own-kid key
 * when there is one, else the greatest key.
 */
export async function publishedStateFromListing(
  dest: AnchorDestination,
  own: OwnKey,
  listedKeys: readonly string[],
  signal?: AbortSignal,
): Promise<PublishedState> {
  const ownKid = kidForPublicKey(own.publicKey);
  const parsedKeys = parseManifestKeys(listedKeys);

  const latestDate = parsedKeys.reduce<string | null>((max, k) => (max === null || k.date > max ? k.date : max), null);
  const onLatestDate = parsedKeys.filter((k) => k.date === latestDate);
  const latestKey =
    onLatestDate.find((k) => k.kid === ownKid)?.key ??
    onLatestDate.reduce<string | null>((max, k) => (max === null || k.key > max ? k.key : max), null);

  return {
    latest: latestKey === null ? null : await readVerifiedManifest(dest, latestKey, own, listedKeys, signal),
    latestDateKeyCount: onLatestDate.length,
    ownKidHasPublished: parsedKeys.some((k) => k.kid === ownKid),
    ownPublicKeyArchived: await isOwnPublicKeyArchived(dest, own, listedKeys, signal),
    manifestKeys: parsedKeys.map((k) => k.key),
  };
}

/** One listing of `dest`, and the published state it shows. */
export async function readPublishedState(
  dest: AnchorDestination,
  own: OwnKey,
  signal?: AbortSignal,
): Promise<PublishedState> {
  return publishedStateFromListing(dest, own, await dest.list(signal), signal);
}
