import { decryptBinary, encryptBinary, type EncryptedBinary } from "@/lib/crypto/crypto-client";
import { hexEncode } from "@/lib/crypto/crypto-utils";
import {
  deriveItemCekWrapKey,
  deriveItemEncryptionKey,
  unwrapItemKey,
  unwrapTeamAttachmentCek,
  wrapTeamAttachmentCek,
} from "@/lib/crypto/crypto-team";
import {
  buildAttachmentAAD,
  buildItemKeyWrapAAD,
  CURRENT_CEK_WRAP_AAD_VERSION,
} from "@/lib/crypto/crypto-aad";
import {
  TEAM_KEY_FAILURE,
  isAesGcmAuthFailure,
  normalizeTeamKeyVersion,
  type ResolveTeamKey,
} from "@/lib/team/team-key-resolution";
import { ATTACHMENT_ENCRYPTION_MODE } from "@/lib/constants/vault/attachment-encryption-mode";

/**
 * Team attachment crypto (docs/archive/review/team-key-rotation-rekey-plan.md
 * C4), React-free so the attachment UI and the re-key pass share it.
 *
 * Modes: 0 (legacy) — body under the team key at `keyVersion`; 1 (legacy) —
 * body under an ItemKey (entry or history wrap, found by trial); 2 — body
 * under a random CEK wrapped with the ItemKey's CEK-wrap key (scope "TW").
 */

/** Wrapped ItemKey as served by the attachment download and migrate routes. */
export interface ItemKeyWrapDto {
  source?: "entry" | "history";
  historyId?: string | null;
  encryptedItemKey: string;
  itemKeyIv: string;
  itemKeyAuthTag: string;
  teamKeyVersion: number;
  itemKeyVersion: number;
}

/** GET /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId] */
export interface TeamAttachmentDownload {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  encryptedData: string;
  iv: string;
  authTag: string;
  aadVersion: number;
  encryptionMode: number;
  keyVersion: number | null;
  cekEncrypted?: string | null;
  cekIv?: string | null;
  cekAuthTag?: string | null;
  cekKeyVersion?: number | null;
  cekWrapAadVersion?: number | null;
  itemKeyWrap?: ItemKeyWrapDto;
  itemKeyWraps?: ItemKeyWrapDto[];
}

export const ATTACHMENT_KEY_FAILURE = {
  /** A key could not be resolved for a retryable reason. */
  TRANSIENT: "transient",
  /** No key available to this member opens the attachment. */
  UNOPENABLE: "unopenable",
} as const;

export type AttachmentKeyFailure = (typeof ATTACHMENT_KEY_FAILURE)[keyof typeof ATTACHMENT_KEY_FAILURE];

export class TeamAttachmentKeyError extends Error {
  constructor(readonly reason: AttachmentKeyFailure) {
    super(`Team attachment key ${reason}`);
    this.name = "TeamAttachmentKeyError";
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked: String.fromCharCode(...bytes) overflows the argument limit on
  // attachment-sized buffers.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** SHA-256 of bytes, lowercase hex (the migrate route's `clientHash`). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hexEncode(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

function bodyAad(entryId: string, attachmentId: string, aadVersion: number): Uint8Array | undefined {
  return aadVersion >= 1 ? buildAttachmentAAD(entryId, attachmentId) : undefined;
}

/**
 * Unwrap the raw ItemKey of a wrap with the team key at the wrap's own
 * version. Returns null when this member cannot open it (no key at that
 * version, a broken key row, or an authentication failure); throws
 * TeamAttachmentKeyError(transient) on a retryable key failure. The caller
 * zeroes the returned bytes.
 */
export async function unwrapItemKeyFromWrap(
  teamId: string,
  entryId: string,
  wrap: ItemKeyWrapDto,
  resolveKey: ResolveTeamKey,
): Promise<Uint8Array | null> {
  const resolved = await resolveKey(normalizeTeamKeyVersion(wrap.teamKeyVersion));
  if (!("key" in resolved)) {
    if (resolved.reason === TEAM_KEY_FAILURE.TRANSIENT) {
      throw new TeamAttachmentKeyError(ATTACHMENT_KEY_FAILURE.TRANSIENT);
    }
    return null;
  }
  try {
    return await unwrapItemKey(
      { ciphertext: wrap.encryptedItemKey, iv: wrap.itemKeyIv, authTag: wrap.itemKeyAuthTag },
      resolved.key,
      buildItemKeyWrapAAD(teamId, entryId, wrap.teamKeyVersion),
    );
  } catch (e) {
    if (isAesGcmAuthFailure(e)) return null;
    throw e;
  }
}

/** Decrypt a downloaded team attachment body, whatever its mode. */
export async function decryptTeamAttachmentDownload(
  teamId: string,
  entryId: string,
  data: TeamAttachmentDownload,
  resolveKey: ResolveTeamKey,
): Promise<ArrayBuffer> {
  const body: EncryptedBinary = {
    ciphertext: base64ToBytes(data.encryptedData),
    iv: data.iv,
    authTag: data.authTag,
  };
  const aad = bodyAad(entryId, data.id, data.aadVersion);

  if (data.encryptionMode === ATTACHMENT_ENCRYPTION_MODE.VAULT_KEY) {
    const resolved = await resolveKey(normalizeTeamKeyVersion(data.keyVersion ?? 0));
    if (!("key" in resolved)) {
      throw new TeamAttachmentKeyError(
        resolved.reason === TEAM_KEY_FAILURE.TRANSIENT
          ? ATTACHMENT_KEY_FAILURE.TRANSIENT
          : ATTACHMENT_KEY_FAILURE.UNOPENABLE,
      );
    }
    return decryptOrUnopenable(() => decryptBinary(body, resolved.key, aad));
  }

  if (data.encryptionMode === ATTACHMENT_ENCRYPTION_MODE.ITEM_KEY) {
    for (const wrap of data.itemKeyWraps ?? []) {
      const itemKey = await unwrapItemKeyFromWrap(teamId, entryId, wrap, resolveKey);
      if (!itemKey) continue;
      let contentKey: CryptoKey;
      try {
        contentKey = await deriveItemEncryptionKey(itemKey);
      } finally {
        itemKey.fill(0);
      }
      try {
        return await decryptBinary(body, contentKey, aad);
      } catch (e) {
        if (!isAesGcmAuthFailure(e)) throw e;
      }
    }
    throw new TeamAttachmentKeyError(ATTACHMENT_KEY_FAILURE.UNOPENABLE);
  }

  if (
    !data.itemKeyWrap ||
    !data.cekEncrypted ||
    !data.cekIv ||
    !data.cekAuthTag ||
    typeof data.cekKeyVersion !== "number" ||
    typeof data.cekWrapAadVersion !== "number"
  ) {
    throw new TeamAttachmentKeyError(ATTACHMENT_KEY_FAILURE.UNOPENABLE);
  }
  const itemKey = await unwrapItemKeyFromWrap(teamId, entryId, data.itemKeyWrap, resolveKey);
  if (!itemKey) throw new TeamAttachmentKeyError(ATTACHMENT_KEY_FAILURE.UNOPENABLE);
  let cekWrapKey: CryptoKey;
  try {
    cekWrapKey = await deriveItemCekWrapKey(itemKey);
  } finally {
    itemKey.fill(0);
  }
  const cek = await unwrapCek(
    { ciphertext: base64ToBytes(data.cekEncrypted), iv: data.cekIv, authTag: data.cekAuthTag },
    cekWrapKey,
    {
      teamId,
      entryId,
      attachmentId: data.id,
      itemKeyVersion: data.cekKeyVersion,
      cekWrapAadVersion: data.cekWrapAadVersion,
    },
  );
  if (!cek) throw new TeamAttachmentKeyError(ATTACHMENT_KEY_FAILURE.UNOPENABLE);
  return decryptOrUnopenable(() => decryptBinary(body, cek, aad));
}

async function decryptOrUnopenable(run: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
  try {
    return await run();
  } catch (e) {
    if (isAesGcmAuthFailure(e)) throw new TeamAttachmentKeyError(ATTACHMENT_KEY_FAILURE.UNOPENABLE);
    throw e;
  }
}

/**
 * Unwrap a mode-2 CEK and import it (decrypt only); null on an
 * authentication failure. The raw CEK bytes are zeroed before returning.
 */
export async function unwrapCek(
  wrapped: EncryptedBinary,
  cekWrapKey: CryptoKey,
  ctx: Parameters<typeof unwrapTeamAttachmentCek>[2],
): Promise<CryptoKey | null> {
  let raw: Uint8Array;
  try {
    raw = await unwrapTeamAttachmentCek(wrapped, cekWrapKey, ctx);
  } catch (e) {
    if (isAesGcmAuthFailure(e)) return null;
    throw e;
  }
  try {
    return await crypto.subtle.importKey(
      "raw",
      raw as Uint8Array<ArrayBuffer>,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
  } finally {
    raw.fill(0);
  }
}

/** A mode-2 body and its CEK wrap, ready for the upload form or the migrate PUT. */
export interface TeamAttachmentMode2 {
  body: EncryptedBinary;
  cekEncrypted: string;
  cekIv: string;
  cekAuthTag: string;
  cekWrapAadVersion: number;
}

/**
 * Encrypt an attachment body under a fresh random CEK (scope "AT" AAD) and
 * wrap the CEK with the ItemKey's CEK-wrap key under the "TW" AAD bound to
 * `itemKeyVersion` (the entry's, sent as `cekKeyVersion`).
 */
export async function encryptTeamAttachmentMode2(
  plaintext: ArrayBuffer,
  ctx: {
    teamId: string;
    entryId: string;
    attachmentId: string;
    itemKeyVersion: number;
    cekWrapKey: CryptoKey;
  },
): Promise<TeamAttachmentMode2> {
  const cekRaw = crypto.getRandomValues(new Uint8Array(32));
  try {
    const cek = await crypto.subtle.importKey(
      "raw",
      cekRaw as Uint8Array<ArrayBuffer>,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const body = await encryptBinary(plaintext, cek, buildAttachmentAAD(ctx.entryId, ctx.attachmentId));
    const wrapped = await wrapTeamAttachmentCek(cekRaw, ctx.cekWrapKey, {
      teamId: ctx.teamId,
      entryId: ctx.entryId,
      attachmentId: ctx.attachmentId,
      itemKeyVersion: ctx.itemKeyVersion,
      cekWrapAadVersion: CURRENT_CEK_WRAP_AAD_VERSION,
    });
    return {
      body,
      cekEncrypted: bytesToBase64(wrapped.ciphertext),
      cekIv: wrapped.iv,
      cekAuthTag: wrapped.authTag,
      cekWrapAadVersion: CURRENT_CEK_WRAP_AAD_VERSION,
    };
  } finally {
    cekRaw.fill(0);
  }
}
