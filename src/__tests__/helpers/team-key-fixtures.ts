/**
 * Real Web Crypto fixtures for the team rotation / re-key client modules:
 * team keys per version, entries and history rows sealed exactly as the
 * clients write them, and an injectable key resolver.
 */
import {
  deriveItemCekWrapKey,
  deriveItemEncryptionKey,
  deriveTeamEncryptionKey,
  generateItemKey,
  generateTeamSymmetricKey,
  wrapItemKey,
  sealTeamEntryField,
  wrapTeamAttachmentCek,
} from "@/lib/crypto/crypto-team";
import { buildItemKeyWrapAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import type { ResolveTeamKey, TeamKeyFailureReason } from "@/lib/team/team-key-resolution";
import { bytesToBase64 } from "@/lib/team/team-attachment-crypto";

export const FIXTURE_TEAM_ID = "11111111-1111-4111-8111-111111111111";

export async function makeTeamKey(): Promise<CryptoKey> {
  const raw = generateTeamSymmetricKey();
  try {
    return await deriveTeamEncryptionKey(raw);
  } finally {
    raw.fill(0);
  }
}

export async function makeTeamKeys(versions: number[]): Promise<Map<number, CryptoKey>> {
  const keys = new Map<number, CryptoKey>();
  for (const v of versions) keys.set(v, await makeTeamKey());
  return keys;
}

/**
 * A resolver over `keys`; versions in `failures` answer that reason, any
 * other missing version answers `not_available`. `calls` records each
 * requested version.
 */
export function makeResolver(
  keys: ReadonlyMap<number, CryptoKey>,
  failures: Readonly<Record<number, TeamKeyFailureReason>> = {},
): ResolveTeamKey & { calls: number[] } {
  const calls: number[] = [];
  const resolve = (async (version: number) => {
    calls.push(version);
    const failure = failures[version];
    if (failure) return { reason: failure };
    const key = keys.get(version);
    return key ? { key } : { reason: "not_available" as const };
  }) as ResolveTeamKey & { calls: number[] };
  resolve.calls = calls;
  return resolve;
}

export interface SealedWrap {
  encryptedItemKey: string;
  itemKeyIv: string;
  itemKeyAuthTag: string;
}

export async function wrapUnder(
  itemKey: Uint8Array,
  teamKey: CryptoKey,
  entryId: string,
  teamKeyVersion: number,
): Promise<SealedWrap> {
  const w = await wrapItemKey(itemKey, teamKey, buildItemKeyWrapAAD(FIXTURE_TEAM_ID, entryId, teamKeyVersion));
  return { encryptedItemKey: w.ciphertext, itemKeyIv: w.iv, itemKeyAuthTag: w.authTag };
}

export async function sealWith(
  key: CryptoKey,
  plaintext: string,
  entryId: string,
  vaultType: "blob" | "overview",
  itemKeyVersion: number,
) {
  return sealTeamEntryField(plaintext, key, {
    teamId: FIXTURE_TEAM_ID,
    entryId,
    vaultType: vaultType === "blob" ? VAULT_TYPE.BLOB : VAULT_TYPE.OVERVIEW,
    itemKeyVersion,
  });
}

/** A v1+ entry under `itemKey`, wrapped under `teamKey` at `teamKeyVersion`. */
export async function sealEntryV1(opts: {
  entryId: string;
  teamKey: CryptoKey;
  teamKeyVersion: number;
  itemKey: Uint8Array;
  itemKeyVersion: number;
  itemKeyId: string | null;
  blob: string;
  overview: string;
  /** Seal at this ItemKey version instead of the recorded one (a wrong-version cell). */
  aadItemKeyVersion?: number;
}) {
  const contentKey = await deriveItemEncryptionKey(opts.itemKey);
  const aadVersion = opts.aadItemKeyVersion ?? opts.itemKeyVersion;
  const blob = await sealWith(contentKey, opts.blob, opts.entryId, "blob", aadVersion);
  const overview = await sealWith(contentKey, opts.overview, opts.entryId, "overview", aadVersion);
  const wrap = await wrapUnder(opts.itemKey, opts.teamKey, opts.entryId, opts.teamKeyVersion);
  return {
    id: opts.entryId,
    encryptedBlob: blob.ciphertext,
    blobIv: blob.iv,
    blobAuthTag: blob.authTag,
    encryptedOverview: overview.ciphertext,
    overviewIv: overview.iv,
    overviewAuthTag: overview.authTag,
    aadVersion: 1,
    teamKeyVersion: opts.teamKeyVersion,
    itemKeyVersion: opts.itemKeyVersion,
    ...wrap,
    itemKeyId: opts.itemKeyId,
  };
}

/** A v0 entry sealed directly under `teamKey`. */
export async function sealEntryV0(opts: {
  entryId: string;
  teamKey: CryptoKey;
  teamKeyVersion: number;
  blob: string;
  overview: string;
  /** Seal at this ItemKey version instead of 0 (a wrong-version cell). */
  aadItemKeyVersion?: number;
}) {
  const blob = await sealWith(opts.teamKey, opts.blob, opts.entryId, "blob", opts.aadItemKeyVersion ?? 0);
  const overview = await sealWith(opts.teamKey, opts.overview, opts.entryId, "overview", opts.aadItemKeyVersion ?? 0);
  return {
    id: opts.entryId,
    encryptedBlob: blob.ciphertext,
    blobIv: blob.iv,
    blobAuthTag: blob.authTag,
    encryptedOverview: overview.ciphertext,
    overviewIv: overview.iv,
    overviewAuthTag: overview.authTag,
    aadVersion: 1,
    teamKeyVersion: opts.teamKeyVersion,
    itemKeyVersion: 0,
    encryptedItemKey: null,
    itemKeyIv: null,
    itemKeyAuthTag: null,
    itemKeyId: null,
  };
}

/**
 * The same row with its blob and overview ciphertexts swapped: each column
 * then holds a field sealed at the other vaultType, which a strict open of
 * that column must refuse.
 */
export function swapBlobAndOverview<T extends {
  encryptedBlob: string;
  blobIv: string;
  blobAuthTag: string;
  encryptedOverview: string;
  overviewIv: string;
  overviewAuthTag: string;
}>(row: T): T {
  return {
    ...row,
    encryptedBlob: row.encryptedOverview,
    blobIv: row.overviewIv,
    blobAuthTag: row.overviewAuthTag,
    encryptedOverview: row.encryptedBlob,
    overviewIv: row.blobIv,
    overviewAuthTag: row.blobAuthTag,
  };
}

/** A history row: blob under `itemKey` (or the team key for v0) with its own wrap. */
export async function sealHistoryRow(opts: {
  id: string;
  entryId: string;
  teamKey: CryptoKey;
  teamKeyVersion: number;
  itemKey: Uint8Array | null;
  itemKeyVersion: number;
  itemKeyId: string | null;
  blob: string;
  /** Seal at this ItemKey version instead of the recorded one (a wrong-version cell). */
  aadItemKeyVersion?: number;
  /** Seal at this vaultType instead of "blob" (a swapped-field cell). */
  aadVaultType?: "blob" | "overview";
}) {
  const contentKey = opts.itemKey ? await deriveItemEncryptionKey(opts.itemKey) : opts.teamKey;
  const blob = await sealWith(
    contentKey, opts.blob, opts.entryId, opts.aadVaultType ?? "blob", opts.aadItemKeyVersion ?? opts.itemKeyVersion,
  );
  const wrap = opts.itemKey
    ? await wrapUnder(opts.itemKey, opts.teamKey, opts.entryId, opts.teamKeyVersion)
    : { encryptedItemKey: null, itemKeyIv: null, itemKeyAuthTag: null };
  return {
    id: opts.id,
    encryptedBlob: blob.ciphertext,
    blobIv: blob.iv,
    blobAuthTag: blob.authTag,
    aadVersion: 1,
    teamKeyVersion: opts.teamKeyVersion,
    itemKeyVersion: opts.itemKeyVersion,
    ...wrap,
    itemKeyId: opts.itemKeyId,
  };
}

/** A mode-2 attachment row (key material only) whose CEK is wrapped under `itemKey`. */
export async function sealAttachmentCek(opts: {
  id: string;
  entryId: string;
  itemKey: Uint8Array;
  itemKeyVersion: number;
  itemKeyId: string | null;
  cek: Uint8Array;
}) {
  const wrapped = await wrapTeamAttachmentCek(opts.cek, await deriveItemCekWrapKey(opts.itemKey), {
    teamId: FIXTURE_TEAM_ID,
    entryId: opts.entryId,
    attachmentId: opts.id,
    itemKeyVersion: opts.itemKeyVersion,
    cekWrapAadVersion: 1,
  });
  return {
    id: opts.id,
    encryptionMode: 2,
    iv: "0".repeat(24),
    authTag: "0".repeat(32),
    keyVersion: 1,
    cekEncrypted: bytesToBase64(wrapped.ciphertext),
    cekIv: wrapped.iv,
    cekAuthTag: wrapped.authTag,
    cekKeyVersion: opts.itemKeyVersion,
    cekWrapAadVersion: 1,
    cekItemKeyId: opts.itemKeyId,
  };
}

export { generateItemKey };
