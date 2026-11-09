import {
  openTeamEntryFieldAt,
  sealTeamEntryField,
  unwrapItemKey,
  wrapItemKey,
  type EncryptedData,
} from "@/lib/crypto/crypto-team";
import { buildItemKeyWrapAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import { ROTATE_CARRY_REASON, type RotateCarryReason } from "@/lib/constants/team/rotate-key";
import {
  TEAM_KEY_FAILURE,
  isAesGcmAuthFailure,
  normalizeTeamKeyVersion,
  type ResolveTeamKey,
  type TeamKeyFailureReason,
} from "@/lib/team/team-key-resolution";

/**
 * Per-entry payload of a team key rotation
 * (docs/archive/review/team-key-rotation-rekey-plan.md C3). React-free: the
 * rotation button supplies the key resolver.
 */

/** One entry as returned by GET /api/teams/[teamId]/rotate-key/data. */
export interface RotationSourceEntry {
  id: string;
  encryptedBlob: string;
  blobIv: string;
  blobAuthTag: string;
  encryptedOverview: string;
  overviewIv: string;
  overviewAuthTag: string;
  teamKeyVersion: number;
  itemKeyVersion: number;
  encryptedItemKey: string | null;
  itemKeyIv: string | null;
  itemKeyAuthTag: string | null;
  itemKeyId?: string | null;
  aadVersion: number;
}

/** v1+: the ItemKey re-wrapped under the new team key. */
export interface RotateEntryV1 {
  id: string;
  itemKeyVersion: number;
  snapshotIv: string;
  encryptedItemKey: EncryptedData;
  aadVersion: number;
}

/** v0: blob and overview re-encrypted under the new team key. */
export interface RotateEntryV0 {
  id: string;
  itemKeyVersion: 0;
  snapshotIv: string;
  snapshotOverviewIv: string;
  encryptedBlob: EncryptedData;
  encryptedOverview: EncryptedData;
  aadVersion: number;
}

export interface RotateCarry {
  id: string;
  teamKeyVersion: number;
  reason: RotateCarryReason;
}

export type RotationEntryResult =
  | { kind: "rotate"; entry: RotateEntryV1 | RotateEntryV0 }
  | { kind: "carry"; carry: RotateCarry };

export interface RotationContext {
  teamId: string;
  newTeamKeyVersion: number;
  newTeamEncryptionKey: CryptoKey;
  /** Normalised team key versions the actor holds (rotate-key/data `actorKeyVersions`). */
  heldVersions: ReadonlySet<number>;
}

/**
 * A key the rotation needs could not be resolved for a reason that says
 * nothing about the entry (network, missing local state, or a version the
 * server says the actor holds but will not serve): the whole rotation stops
 * before anything is sent.
 */
export class RotationAbortedError extends Error {
  constructor(readonly reason: TeamKeyFailureReason, readonly teamKeyVersion: number) {
    super(`Rotation aborted: team key version ${teamKeyVersion} ${reason}`);
    this.name = "RotationAbortedError";
  }
}

const V0_AAD_VERSION = 1;

/**
 * Build one entry's part of the rotation POST. The entry is opened with the
 * team key at its OWN (normalised) version:
 * - actor holds no key at that version → carry `not_held` (server-verified);
 * - the actor's key row at that version fails to unwrap → carry `key_invalid`;
 * - the entry fails AES-GCM authentication under a key the actor's wrap
 *   authenticated → carry `undecryptable` (ciphertext untouched);
 * - any other failure to resolve a key aborts the rotation (RotationAbortedError);
 * - otherwise v1+ re-wraps the ItemKey and v0 re-encrypts blob + overview.
 */
export async function buildRotationEntryPayload(
  entry: RotationSourceEntry,
  resolveKey: ResolveTeamKey,
  ctx: RotationContext,
): Promise<RotationEntryResult> {
  const version = normalizeTeamKeyVersion(entry.teamKeyVersion);
  const carry = (reason: RotateCarryReason): RotationEntryResult => ({
    kind: "carry",
    carry: { id: entry.id, teamKeyVersion: version, reason },
  });

  if (!ctx.heldVersions.has(version)) {
    return carry(ROTATE_CARRY_REASON.NOT_HELD);
  }

  const resolved = await resolveKey(version);
  if (!("key" in resolved)) {
    if (resolved.reason === TEAM_KEY_FAILURE.KEY_INVALID) {
      return carry(ROTATE_CARRY_REASON.KEY_INVALID);
    }
    throw new RotationAbortedError(resolved.reason, version);
  }
  const oldTeamKey = resolved.key;

  try {
    if (entry.itemKeyVersion >= 1) {
      // Not an authentication failure, so not an `undecryptable` claim.
      if (!entry.encryptedItemKey || !entry.itemKeyIv || !entry.itemKeyAuthTag) {
        throw new Error("Entry has itemKeyVersion >= 1 but no ItemKey wrap");
      }
      return { kind: "rotate", entry: await rewrapItemKey(entry, oldTeamKey, ctx) };
    }
    return { kind: "rotate", entry: await reencryptV0(entry, oldTeamKey, ctx) };
  } catch (e) {
    if (isAesGcmAuthFailure(e)) return carry(ROTATE_CARRY_REASON.UNDECRYPTABLE);
    throw e;
  }
}

async function rewrapItemKey(
  entry: RotationSourceEntry,
  oldTeamKey: CryptoKey,
  ctx: RotationContext,
): Promise<RotateEntryV1> {
  // The wrap's AAD carries the raw team key version recorded at wrap time.
  const rawItemKey = await unwrapItemKey(
    {
      ciphertext: entry.encryptedItemKey as string,
      iv: entry.itemKeyIv as string,
      authTag: entry.itemKeyAuthTag as string,
    },
    oldTeamKey,
    buildItemKeyWrapAAD(ctx.teamId, entry.id, entry.teamKeyVersion),
  );
  try {
    const encryptedItemKey = await wrapItemKey(
      rawItemKey,
      ctx.newTeamEncryptionKey,
      buildItemKeyWrapAAD(ctx.teamId, entry.id, ctx.newTeamKeyVersion),
    );
    return {
      id: entry.id,
      itemKeyVersion: entry.itemKeyVersion,
      // The server applies the re-wrap only while the row still holds this wrap.
      snapshotIv: entry.itemKeyIv as string,
      encryptedItemKey,
      aadVersion: entry.aadVersion,
    };
  } finally {
    rawItemKey.fill(0);
  }
}

async function reencryptV0(
  entry: RotationSourceEntry,
  oldTeamKey: CryptoKey,
  ctx: RotationContext,
): Promise<RotateEntryV0> {
  const blob = await openTeamEntryFieldAt(
    { ciphertext: entry.encryptedBlob, iv: entry.blobIv, authTag: entry.blobAuthTag },
    oldTeamKey,
    { teamId: ctx.teamId, entryId: entry.id, vaultType: VAULT_TYPE.BLOB, itemKeyVersion: 0 },
    entry.aadVersion,
  );
  const overview = await openTeamEntryFieldAt(
    { ciphertext: entry.encryptedOverview, iv: entry.overviewIv, authTag: entry.overviewAuthTag },
    oldTeamKey,
    { teamId: ctx.teamId, entryId: entry.id, vaultType: VAULT_TYPE.OVERVIEW, itemKeyVersion: 0 },
    entry.aadVersion,
  );
  return {
    id: entry.id,
    itemKeyVersion: 0,
    // Both ciphertexts are replaced, so the snapshot names both IVs.
    snapshotIv: entry.blobIv,
    snapshotOverviewIv: entry.overviewIv,
    encryptedBlob: await sealTeamEntryField(
      blob,
      ctx.newTeamEncryptionKey,
      { teamId: ctx.teamId, entryId: entry.id, vaultType: VAULT_TYPE.BLOB, itemKeyVersion: 0 },
    ),
    encryptedOverview: await sealTeamEntryField(
      overview,
      ctx.newTeamEncryptionKey,
      { teamId: ctx.teamId, entryId: entry.id, vaultType: VAULT_TYPE.OVERVIEW, itemKeyVersion: 0 },
    ),
    aadVersion: V0_AAD_VERSION,
  };
}

/**
 * Builds every entry's part, in order, sharing one resolution per team key
 * version. Throws RotationAbortedError before returning anything when a key
 * fails transiently.
 */
export async function buildRotationPayload(
  entries: readonly RotationSourceEntry[],
  resolveKey: ResolveTeamKey,
  ctx: RotationContext,
  onProgress?: (done: number, total: number) => void,
): Promise<{ entries: (RotateEntryV1 | RotateEntryV0)[]; carry: RotateCarry[] }> {
  const memo = new Map<number, ReturnType<ResolveTeamKey>>();
  const resolveOnce: ResolveTeamKey = (version) => {
    let pending = memo.get(version);
    if (!pending) {
      pending = resolveKey(version);
      memo.set(version, pending);
    }
    return pending;
  };
  const rotated: (RotateEntryV1 | RotateEntryV0)[] = [];
  const carried: RotateCarry[] = [];
  for (let i = 0; i < entries.length; i++) {
    onProgress?.(i, entries.length);
    const result = await buildRotationEntryPayload(entries[i], resolveOnce, ctx);
    if (result.kind === "rotate") rotated.push(result.entry);
    else carried.push(result.carry);
  }
  onProgress?.(entries.length, entries.length);
  return { entries: rotated, carry: carried };
}
