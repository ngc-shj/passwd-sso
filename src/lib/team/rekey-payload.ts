import {
  decryptTeamEntry,
  deriveItemCekWrapKey,
  deriveItemEncryptionKey,
  encryptTeamEntry,
  generateItemKey,
  unwrapItemKey,
  unwrapTeamAttachmentCek,
  wrapItemKey,
  wrapTeamAttachmentCek,
  type EncryptedData,
} from "@/lib/crypto/crypto-team";
import {
  AAD_VERSION,
  buildItemKeyWrapAAD,
  buildTeamEntryAAD,
  CURRENT_CEK_WRAP_AAD_VERSION,
  VAULT_TYPE,
} from "@/lib/crypto/crypto-aad";
import {
  TEAM_KEY_FAILURE,
  isAesGcmAuthFailure,
  itemKeyIdsMatch,
  normalizeTeamKeyVersion,
  teamEntryAadFor,
  type ResolveTeamKey,
  type TeamKeyResolution,
} from "@/lib/team/team-key-resolution";
import {
  base64ToBytes,
  bytesToBase64,
  decryptTeamAttachmentDownload,
  encryptTeamAttachmentMode2,
  sha256Hex,
  type TeamAttachmentDownload,
} from "@/lib/team/team-attachment-crypto";
import { isRestorableHistoryRow } from "@/lib/team/team-history-restore";
import { ATTACHMENT_ENCRYPTION_MODE } from "@/lib/constants/vault/attachment-encryption-mode";

/**
 * Client payloads of the re-key pass
 * (docs/archive/review/team-key-rotation-rekey-plan.md C2, C3; deviation
 * D23–D26). React-free: the runner injects the key resolver.
 */

// ─── Server shapes ─────────────────────────────────────────────────────────

/** Entry ciphertext + wrap, as GET /passwords/[id] and GET /passwords/[id]/rekey return it. */
export interface RekeySourceEntry {
  id: string;
  encryptedBlob: string;
  blobIv: string;
  blobAuthTag: string;
  encryptedOverview: string;
  overviewIv: string;
  overviewAuthTag: string;
  aadVersion: number;
  teamKeyVersion: number;
  itemKeyVersion: number;
  encryptedItemKey?: string | null;
  itemKeyIv?: string | null;
  itemKeyAuthTag?: string | null;
  itemKeyId?: string | null;
  itemKeyTeamKeyVersion?: number;
}

export interface RekeySourceHistory {
  id: string;
  encryptedBlob: string;
  blobIv: string;
  blobAuthTag: string;
  aadVersion: number;
  teamKeyVersion: number;
  itemKeyVersion: number;
  encryptedItemKey: string | null;
  itemKeyIv: string | null;
  itemKeyAuthTag: string | null;
  itemKeyId: string | null;
}

export interface RekeySourceAttachment {
  id: string;
  encryptionMode: number;
  iv: string;
  authTag: string;
  keyVersion: number | null;
  cekEncrypted: string | null;
  cekIv: string | null;
  cekAuthTag: string | null;
  cekKeyVersion: number | null;
  cekWrapAadVersion: number | null;
  cekItemKeyId: string | null;
}

/** GET /api/teams/[teamId]/passwords/[id]/rekey */
export interface RekeyEntryData {
  entry: RekeySourceEntry;
  history: RekeySourceHistory[];
  attachments: RekeySourceAttachment[];
  nextItemKeyVersion: number;
  teamKeyVersion: number;
}

/** POST /api/teams/[teamId]/passwords/[id]/rekey body. */
export interface RekeyPostBody {
  teamKeyVersion: number;
  snapshot: { blobIv: string; overviewIv: string; itemKeyIv: string; itemKeyVersion: number };
  newItemKeyVersion: number;
  encryptedItemKey: EncryptedData;
  encryptedBlob: EncryptedData;
  encryptedOverview: EncryptedData;
  aadVersion: number;
  /** Each re-keyed history row at its own, unchanged AAD label (0 for a legacy row, D80). */
  history: { id: string; snapshotBlobIv: string; aadVersion: number; encryptedBlob: EncryptedData }[];
  retainHistoryIds: string[];
  attachmentCekRewraps: {
    id: string;
    snapshotCekIv: string;
    cekEncrypted: string;
    cekIv: string;
    cekAuthTag: string;
  }[];
}

// ─── Results ───────────────────────────────────────────────────────────────

/** Why an entry cannot be re-keyed by this runner now. */
export const REKEY_ENTRY_BLOCK = {
  /** The actor holds no key at the live entry's version. */
  NOT_HELD: "not_held",
  /** The actor's key row at the live entry's version fails to unwrap. */
  KEY_INVALID: "key_invalid",
  /** The live wrap, blob or overview fails authentication under a held key. */
  UNDECRYPTABLE: "undecryptable",
  /** An attachment CEK no ItemKey the runner holds opens. */
  ATTACHMENT_UNOPENABLE: "attachment_unopenable",
  /** v0 entry: upgrade it first (D23). */
  NEEDS_UPGRADE: "needs_upgrade",
  /** A legacy (mode 0/1) attachment: migrate it first (D24). */
  NEEDS_MIGRATION: "needs_migration",
} as const;

export type RekeyEntryBlock = (typeof REKEY_ENTRY_BLOCK)[keyof typeof REKEY_ENTRY_BLOCK];

export type EntryRekeyPayloadResult =
  | {
      kind: "payload";
      body: RekeyPostBody;
      /** History rows left under their old key, with their versions. */
      retained: { id: string; teamKeyVersion: number }[];
    }
  | { kind: "blocked"; block: RekeyEntryBlock; teamKeyVersion: number };

/** A key needed by the pass failed for a retryable reason: stop, send nothing. */
export class RekeyTransientError extends Error {
  constructor(readonly teamKeyVersion: number) {
    super(`Re-key stopped: team key version ${teamKeyVersion} unavailable (transient)`);
    this.name = "RekeyTransientError";
  }
}

/** The actor cannot resolve the team's CURRENT key: no new wrap can be made. */
export class RekeyCurrentKeyUnavailableError extends Error {
  constructor(readonly teamKeyVersion: number, readonly reason: string) {
    super(`Re-key stopped: current team key version ${teamKeyVersion} ${reason}`);
    this.name = "RekeyCurrentKeyUnavailableError";
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** One resolution per version for the duration of a build. */
function memoResolver(resolveKey: ResolveTeamKey): ResolveTeamKey {
  const memo = new Map<number, Promise<TeamKeyResolution>>();
  return (version) => {
    const v = normalizeTeamKeyVersion(version);
    let pending = memo.get(v);
    if (!pending) {
      pending = resolveKey(v);
      memo.set(v, pending);
    }
    return pending;
  };
}

async function requireCurrentKey(resolveKey: ResolveTeamKey, version: number): Promise<CryptoKey> {
  const resolved = await resolveKey(version);
  if ("key" in resolved) return resolved.key;
  if (resolved.reason === TEAM_KEY_FAILURE.TRANSIENT) throw new RekeyTransientError(version);
  throw new RekeyCurrentKeyUnavailableError(version, resolved.reason);
}

interface HeldItemKey {
  itemKeyId: string | null;
  raw: Uint8Array;
  contentKey: CryptoKey;
  cekWrapKey: CryptoKey;
}

type WrapFields = {
  teamKeyVersion: number;
  itemKeyVersion: number;
  encryptedItemKey?: string | null;
  itemKeyIv?: string | null;
  itemKeyAuthTag?: string | null;
};

type UnwrapOutcome =
  | { ok: true; raw: Uint8Array }
  | { ok: false; reason: "not_held" | "key_invalid" | "undecryptable" };

async function unwrapRow(
  teamId: string,
  entryId: string,
  row: WrapFields,
  resolveKey: ResolveTeamKey,
): Promise<UnwrapOutcome> {
  if (row.itemKeyVersion < 1 || !row.encryptedItemKey || !row.itemKeyIv || !row.itemKeyAuthTag) {
    return { ok: false, reason: "undecryptable" };
  }
  const resolved = await resolveKey(normalizeTeamKeyVersion(row.teamKeyVersion));
  if (!("key" in resolved)) {
    if (resolved.reason === TEAM_KEY_FAILURE.TRANSIENT) {
      throw new RekeyTransientError(normalizeTeamKeyVersion(row.teamKeyVersion));
    }
    return {
      ok: false,
      reason: resolved.reason === TEAM_KEY_FAILURE.KEY_INVALID ? "key_invalid" : "not_held",
    };
  }
  try {
    const raw = await unwrapItemKey(
      { ciphertext: row.encryptedItemKey, iv: row.itemKeyIv, authTag: row.itemKeyAuthTag },
      resolved.key,
      buildItemKeyWrapAAD(teamId, entryId, row.teamKeyVersion),
    );
    return { ok: true, raw };
  } catch (e) {
    if (isAesGcmAuthFailure(e)) return { ok: false, reason: "undecryptable" };
    throw e;
  }
}

async function toHeld(itemKeyId: string | null, raw: Uint8Array): Promise<HeldItemKey> {
  return {
    itemKeyId,
    raw,
    contentKey: await deriveItemEncryptionKey(raw),
    cekWrapKey: await deriveItemCekWrapKey(raw),
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function tryDecrypt(
  encrypted: EncryptedData,
  key: CryptoKey,
  aad: Uint8Array | undefined,
): Promise<string | null> {
  try {
    return await decryptTeamEntry(encrypted, key, aad);
  } catch (e) {
    if (isAesGcmAuthFailure(e)) return null;
    throw e;
  }
}

// ─── Re-key POST payload ───────────────────────────────────────────────────

/**
 * Build the re-key POST for one entry (C2, D23–D26). The live blob/overview
 * open with the live ItemKey; each history row with its own wrap, else by
 * trial with every ItemKey the runner holds for the entry (the live one and
 * every history wrap it could open), at strict entry AAD; rows it cannot open
 * are retained. A legacy row (the rows the history restore refuses: aadVersion
 * below 1 or non-numeric) is opened and re-sealed WITHOUT AAD and labelled 0
 * (resealLegacyHistoryRow, D80): the new ItemKey takes it away from departed
 * holders of the old one, while it stays a row the restore refuses — re-sealing
 * it at AAD 1 would launder a substituted ciphertext into a restorable row
 * (D76). Each
 * mode-2 CEK opens with the ItemKey whose id matches, else by trial. A new
 * random ItemKey takes `nextItemKeyVersion` and is wrapped with a fresh IV
 * under the CURRENT team key. The entry is blocked (skip and report) when the
 * live row or an attachment cannot be opened.
 */
export async function buildEntryRekeyPayload(
  teamId: string,
  data: RekeyEntryData,
  resolveKey: ResolveTeamKey,
): Promise<EntryRekeyPayloadResult> {
  const resolve = memoResolver(resolveKey);
  const { entry } = data;
  const entryId = entry.id;
  const liveVersion = normalizeTeamKeyVersion(entry.teamKeyVersion);
  const blocked = (block: RekeyEntryBlock, teamKeyVersion = liveVersion): EntryRekeyPayloadResult => ({
    kind: "blocked",
    block,
    teamKeyVersion,
  });

  if (entry.itemKeyVersion < 1) return blocked(REKEY_ENTRY_BLOCK.NEEDS_UPGRADE);
  if (data.attachments.some((a) => a.encryptionMode !== ATTACHMENT_ENCRYPTION_MODE.CEK_WRAPPED)) {
    return blocked(REKEY_ENTRY_BLOCK.NEEDS_MIGRATION);
  }

  const currentKey = await requireCurrentKey(resolve, data.teamKeyVersion);
  const held: HeldItemKey[] = [];
  // Every raw ItemKey unwrapped here, registered before anything derived from
  // it can throw, so the finally zero-fills it whatever happens next.
  const raws: Uint8Array[] = [];
  const newItemKey = generateItemKey();
  try {
    const live = await unwrapRow(teamId, entryId, entry, resolve);
    if (!live.ok) {
      return blocked(
        live.reason === "not_held"
          ? REKEY_ENTRY_BLOCK.NOT_HELD
          : live.reason === "key_invalid"
            ? REKEY_ENTRY_BLOCK.KEY_INVALID
            : REKEY_ENTRY_BLOCK.UNDECRYPTABLE,
      );
    }
    raws.push(live.raw);
    const liveHeld = await toHeld(entry.itemKeyId ?? null, live.raw);
    held.push(liveHeld);

    const blob = await tryDecrypt(
      { ciphertext: entry.encryptedBlob, iv: entry.blobIv, authTag: entry.blobAuthTag },
      liveHeld.contentKey,
      teamEntryAadFor(teamId, entryId, VAULT_TYPE.BLOB, entry.itemKeyVersion, entry.aadVersion),
    );
    const overview = await tryDecrypt(
      { ciphertext: entry.encryptedOverview, iv: entry.overviewIv, authTag: entry.overviewAuthTag },
      liveHeld.contentKey,
      teamEntryAadFor(teamId, entryId, VAULT_TYPE.OVERVIEW, entry.itemKeyVersion, entry.aadVersion),
    );
    if (blob === null || overview === null) return blocked(REKEY_ENTRY_BLOCK.UNDECRYPTABLE);

    // Every history wrap the runner can open joins the trial set. A row's
    // wrap failing for any reason only means that row falls back to trial.
    const ownKeyByRow = new Map<string, HeldItemKey>();
    for (const row of data.history) {
      if (row.itemKeyVersion < 1) continue;
      const unwrapped = await unwrapRow(teamId, entryId, row, resolve);
      if (!unwrapped.ok) continue;
      raws.push(unwrapped.raw);
      const existing = held.find((h) => sameBytes(h.raw, unwrapped.raw));
      if (existing) {
        unwrapped.raw.fill(0);
        ownKeyByRow.set(row.id, existing);
      } else {
        const h = await toHeld(row.itemKeyId, unwrapped.raw);
        held.push(h);
        ownKeyByRow.set(row.id, h);
      }
    }

    const newItemKeyVersion = data.nextItemKeyVersion;
    const newContentKey = await deriveItemEncryptionKey(newItemKey);
    const newCekWrapKey = await deriveItemCekWrapKey(newItemKey);

    const history: RekeyPostBody["history"] = [];
    const retained: { id: string; teamKeyVersion: number }[] = [];
    for (const row of data.history) {
      const keys = await historyRowKeys(row, ownKeyByRow.get(row.id), held, resolve);
      const encrypted = { ciphertext: row.encryptedBlob, iv: row.blobIv, authTag: row.blobAuthTag };
      const resealed = isRestorableHistoryRow(row)
        ? await resealHistoryRow(teamId, entryId, row.itemKeyVersion, encrypted, keys, newContentKey, newItemKeyVersion)
        : await resealLegacyHistoryRow(encrypted, keys, newContentKey);
      if (resealed === null) {
        retained.push({ id: row.id, teamKeyVersion: normalizeTeamKeyVersion(row.teamKeyVersion) });
        continue;
      }
      history.push({
        id: row.id,
        snapshotBlobIv: row.blobIv,
        aadVersion: isRestorableHistoryRow(row) ? AAD_VERSION : 0,
        encryptedBlob: resealed,
      });
    }

    const attachmentCekRewraps: RekeyPostBody["attachmentCekRewraps"] = [];
    for (const att of data.attachments) {
      const rewrap = await rewrapAttachmentCek(teamId, entryId, att, held, newCekWrapKey, newItemKeyVersion);
      if (!rewrap) return blocked(REKEY_ENTRY_BLOCK.ATTACHMENT_UNOPENABLE);
      attachmentCekRewraps.push(rewrap);
    }

    const body: RekeyPostBody = {
      teamKeyVersion: data.teamKeyVersion,
      snapshot: {
        blobIv: entry.blobIv,
        overviewIv: entry.overviewIv,
        itemKeyIv: entry.itemKeyIv as string,
        itemKeyVersion: entry.itemKeyVersion,
      },
      newItemKeyVersion,
      encryptedItemKey: await wrapItemKey(
        newItemKey,
        currentKey,
        buildItemKeyWrapAAD(teamId, entryId, data.teamKeyVersion),
      ),
      encryptedBlob: await encryptTeamEntry(
        blob,
        newContentKey,
        buildTeamEntryAAD(teamId, entryId, VAULT_TYPE.BLOB, newItemKeyVersion),
      ),
      encryptedOverview: await encryptTeamEntry(
        overview,
        newContentKey,
        buildTeamEntryAAD(teamId, entryId, VAULT_TYPE.OVERVIEW, newItemKeyVersion),
      ),
      aadVersion: AAD_VERSION,
      history,
      retainHistoryIds: retained.map((r) => r.id),
      attachmentCekRewraps,
    };
    return { kind: "payload", body, retained };
  } finally {
    newItemKey.fill(0);
    for (const raw of raws) raw.fill(0);
  }
}

/**
 * The keys a history row may open with: a v0 row (sealed directly under the
 * team key) the team key at its own version; any other its own ItemKey first,
 * then every ItemKey held for the entry.
 */
async function historyRowKeys(
  row: RekeySourceHistory,
  ownKey: HeldItemKey | undefined,
  held: readonly HeldItemKey[],
  resolve: ResolveTeamKey,
): Promise<CryptoKey[]> {
  if (row.itemKeyVersion < 1) {
    const resolved = await resolve(normalizeTeamKeyVersion(row.teamKeyVersion));
    if (!("key" in resolved)) {
      if (resolved.reason === TEAM_KEY_FAILURE.TRANSIENT) {
        throw new RekeyTransientError(normalizeTeamKeyVersion(row.teamKeyVersion));
      }
      return [];
    }
    return [resolved.key];
  }
  const candidates = ownKey ? [ownKey, ...held.filter((h) => h !== ownKey)] : held;
  return candidates.map((h) => h.contentKey);
}

/** A history row opened at strict entry AAD and re-sealed at the new ItemKey's; null if no key opens it. */
async function resealHistoryRow(
  teamId: string,
  entryId: string,
  itemKeyVersion: number,
  encrypted: EncryptedData,
  keys: readonly CryptoKey[],
  newContentKey: CryptoKey,
  newItemKeyVersion: number,
): Promise<EncryptedData | null> {
  const aad = buildTeamEntryAAD(teamId, entryId, VAULT_TYPE.BLOB, itemKeyVersion);
  for (const key of keys) {
    const plaintext = await tryDecrypt(encrypted, key, aad);
    if (plaintext !== null) {
      return encryptTeamEntry(plaintext, newContentKey, buildTeamEntryAAD(teamId, entryId, VAULT_TYPE.BLOB, newItemKeyVersion));
    }
  }
  return null;
}

/**
 * The ONE team entry re-seal without AAD (D80; confined to this module by
 * team-entry-aad-strictness.test.ts): a legacy history row, which carries no
 * entry binding, opened without AAD and re-sealed without AAD under the new
 * ItemKey, so it stays a row the history restore refuses. null if no key
 * opens it (the row is retained). Opening unbound ciphertext here is the
 * accepted risk the history view already takes (threat model T2).
 */
async function resealLegacyHistoryRow(
  encrypted: EncryptedData,
  keys: readonly CryptoKey[],
  newContentKey: CryptoKey,
): Promise<EncryptedData | null> {
  for (const key of keys) {
    const plaintext = await tryDecrypt(encrypted, key, undefined);
    if (plaintext !== null) return encryptTeamEntry(plaintext, newContentKey);
  }
  return null;
}

async function rewrapAttachmentCek(
  teamId: string,
  entryId: string,
  att: RekeySourceAttachment,
  held: readonly HeldItemKey[],
  newCekWrapKey: CryptoKey,
  newItemKeyVersion: number,
): Promise<RekeyPostBody["attachmentCekRewraps"][number] | null> {
  if (
    !att.cekEncrypted ||
    !att.cekIv ||
    !att.cekAuthTag ||
    typeof att.cekKeyVersion !== "number" ||
    typeof att.cekWrapAadVersion !== "number"
  ) {
    return null;
  }
  const wrapped = { ciphertext: base64ToBytes(att.cekEncrypted), iv: att.cekIv, authTag: att.cekAuthTag };
  const ctx = {
    teamId,
    entryId,
    attachmentId: att.id,
    itemKeyVersion: att.cekKeyVersion,
    cekWrapAadVersion: att.cekWrapAadVersion,
  };
  const matching = held.find((h) => itemKeyIdsMatch(h.itemKeyId, att.cekItemKeyId));
  const candidates = matching ? [matching, ...held.filter((h) => h !== matching)] : held;
  for (const candidate of candidates) {
    let cekRaw: Uint8Array;
    try {
      cekRaw = await unwrapTeamAttachmentCek(wrapped, candidate.cekWrapKey, ctx);
    } catch (e) {
      if (isAesGcmAuthFailure(e)) continue;
      throw e;
    }
    try {
      const rewrapped = await wrapTeamAttachmentCek(cekRaw, newCekWrapKey, {
        ...ctx,
        itemKeyVersion: newItemKeyVersion,
        cekWrapAadVersion: CURRENT_CEK_WRAP_AAD_VERSION,
      });
      return {
        id: att.id,
        snapshotCekIv: att.cekIv,
        cekEncrypted: bytesToBase64(rewrapped.ciphertext),
        cekIv: rewrapped.iv,
        cekAuthTag: rewrapped.authTag,
      };
    } finally {
      cekRaw.fill(0);
    }
  }
  return null;
}

// ─── v0 → v1 upgrade PUT payload ───────────────────────────────────────────

/** PUT /api/teams/[teamId]/passwords/[id] body for the v0→v1 upgrade. */
export interface EntryUpgradeBody {
  encryptedBlob: EncryptedData;
  encryptedOverview: EncryptedData;
  aadVersion: number;
  teamKeyVersion: number;
  itemKeyVersion: number;
  encryptedItemKey: EncryptedData;
  snapshotBlobIv: string;
}

export type EntryUpgradeResult =
  | { kind: "payload"; body: EntryUpgradeBody }
  | { kind: "blocked"; block: RekeyEntryBlock; teamKeyVersion: number };

/**
 * Build the v0→v1 upgrade PUT (C1): blob and overview decrypted with the team
 * key at the entry's own version, re-encrypted under a new random ItemKey at
 * `nextItemKeyVersion`, which is wrapped with a fresh IV under the CURRENT
 * team key; `snapshotBlobIv` names the blob it replaces.
 */
export async function buildEntryUpgradePayload(
  teamId: string,
  entry: RekeySourceEntry,
  nextItemKeyVersion: number,
  currentTeamKeyVersion: number,
  resolveKey: ResolveTeamKey,
): Promise<EntryUpgradeResult> {
  const resolve = memoResolver(resolveKey);
  const version = normalizeTeamKeyVersion(entry.teamKeyVersion);
  const resolved = await resolve(version);
  if (!("key" in resolved)) {
    if (resolved.reason === TEAM_KEY_FAILURE.TRANSIENT) throw new RekeyTransientError(version);
    return {
      kind: "blocked",
      block: resolved.reason === TEAM_KEY_FAILURE.KEY_INVALID
        ? REKEY_ENTRY_BLOCK.KEY_INVALID
        : REKEY_ENTRY_BLOCK.NOT_HELD,
      teamKeyVersion: version,
    };
  }
  const blob = await tryDecrypt(
    { ciphertext: entry.encryptedBlob, iv: entry.blobIv, authTag: entry.blobAuthTag },
    resolved.key,
    teamEntryAadFor(teamId, entry.id, VAULT_TYPE.BLOB, 0, entry.aadVersion),
  );
  const overview = await tryDecrypt(
    { ciphertext: entry.encryptedOverview, iv: entry.overviewIv, authTag: entry.overviewAuthTag },
    resolved.key,
    teamEntryAadFor(teamId, entry.id, VAULT_TYPE.OVERVIEW, 0, entry.aadVersion),
  );
  if (blob === null || overview === null) {
    return { kind: "blocked", block: REKEY_ENTRY_BLOCK.UNDECRYPTABLE, teamKeyVersion: version };
  }
  return {
    kind: "payload",
    body: await encryptUpgrade(teamId, entry, blob, overview, nextItemKeyVersion, currentTeamKeyVersion, resolve),
  };
}

/**
 * The upgrade body from plaintext the caller already holds (the edit form):
 * new ItemKey at `nextItemKeyVersion`, wrapped under the current team key.
 */
export async function encryptUpgrade(
  teamId: string,
  entry: Pick<RekeySourceEntry, "id" | "blobIv">,
  blob: string,
  overview: string,
  nextItemKeyVersion: number,
  currentTeamKeyVersion: number,
  resolveKey: ResolveTeamKey,
): Promise<EntryUpgradeBody> {
  const currentKey = await requireCurrentKey(resolveKey, currentTeamKeyVersion);
  const itemKey = generateItemKey();
  try {
    const contentKey = await deriveItemEncryptionKey(itemKey);
    return {
      encryptedBlob: await encryptTeamEntry(
        blob,
        contentKey,
        buildTeamEntryAAD(teamId, entry.id, VAULT_TYPE.BLOB, nextItemKeyVersion),
      ),
      encryptedOverview: await encryptTeamEntry(
        overview,
        contentKey,
        buildTeamEntryAAD(teamId, entry.id, VAULT_TYPE.OVERVIEW, nextItemKeyVersion),
      ),
      aadVersion: AAD_VERSION,
      teamKeyVersion: currentTeamKeyVersion,
      itemKeyVersion: nextItemKeyVersion,
      encryptedItemKey: await wrapItemKey(
        itemKey,
        currentKey,
        buildItemKeyWrapAAD(teamId, entry.id, currentTeamKeyVersion),
      ),
      snapshotBlobIv: entry.blobIv,
    };
  } finally {
    itemKey.fill(0);
  }
}

// ─── Legacy attachment migrate PUT payload ─────────────────────────────────

/** PUT /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]/migrate body. */
export interface AttachmentMigrateBody {
  /** null for an entry whose ItemKey has no id yet (written by a previous release). */
  itemKeyId: string | null;
  cekKeyVersion: number;
  snapshot: { iv: string; authTag: string };
  clientHash: string;
  encryptedData: string;
  iv: string;
  authTag: string;
  cekEncrypted: string;
  cekIv: string;
  cekAuthTag: string;
  cekWrapAadVersion: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
  aadVersion: number;
}

/**
 * Re-encrypt a legacy (mode 0/1) attachment as mode 2 under the entry's live
 * ItemKey (C4): mode 0 opens with the team key at `keyVersion` (null/0 → 1),
 * mode 1 by trial over the served wraps. Throws TeamAttachmentKeyError when
 * no available key opens it.
 */
export async function buildAttachmentMigratePayload(
  teamId: string,
  entryId: string,
  download: TeamAttachmentDownload,
  live: { itemKeyId: string | null; itemKeyVersion: number; cekWrapKey: CryptoKey },
  resolveKey: ResolveTeamKey,
): Promise<AttachmentMigrateBody> {
  const plaintext = await decryptTeamAttachmentDownload(teamId, entryId, download, resolveKey);
  const mode2 = await encryptTeamAttachmentMode2(plaintext, {
    teamId,
    entryId,
    attachmentId: download.id,
    itemKeyVersion: live.itemKeyVersion,
    cekWrapKey: live.cekWrapKey,
  });
  return {
    itemKeyId: live.itemKeyId,
    cekKeyVersion: live.itemKeyVersion,
    snapshot: { iv: download.iv, authTag: download.authTag },
    clientHash: await sha256Hex(base64ToBytes(download.encryptedData)),
    encryptedData: bytesToBase64(mode2.body.ciphertext),
    iv: mode2.body.iv,
    authTag: mode2.body.authTag,
    cekEncrypted: mode2.cekEncrypted,
    cekIv: mode2.cekIv,
    cekAuthTag: mode2.cekAuthTag,
    cekWrapAadVersion: mode2.cekWrapAadVersion,
    filename: download.filename,
    contentType: download.contentType,
    sizeBytes: download.sizeBytes,
    aadVersion: AAD_VERSION,
  };
}

export type LiveCekWrapKeyResult =
  | { ok: true; cekWrapKey: CryptoKey }
  | {
      ok: false;
      block: typeof REKEY_ENTRY_BLOCK.NOT_HELD | typeof REKEY_ENTRY_BLOCK.KEY_INVALID | typeof REKEY_ENTRY_BLOCK.UNDECRYPTABLE;
    };

/**
 * Unwrap the live entry wrap into its CEK-wrap key (for migrate), or say why
 * it does not open — the same reasons the re-key payload reports for it.
 */
export async function liveCekWrapKey(
  teamId: string,
  entry: RekeySourceEntry,
  resolveKey: ResolveTeamKey,
): Promise<LiveCekWrapKeyResult> {
  const unwrapped = await unwrapRow(teamId, entry.id, entry, resolveKey);
  if (!unwrapped.ok) return { ok: false, block: unwrapped.reason };
  try {
    return { ok: true, cekWrapKey: await deriveItemCekWrapKey(unwrapped.raw) };
  } finally {
    unwrapped.raw.fill(0);
  }
}
