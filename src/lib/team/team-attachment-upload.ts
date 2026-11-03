import { apiPath } from "@/lib/constants";
import { AAD_VERSION } from "@/lib/crypto/crypto-aad";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { readApiErrorBody } from "@/lib/http/read-api-error-body";
import type { ResolveTeamKey } from "@/lib/team/team-key-resolution";
import { buildEntryUpgradePayload, type RekeySourceEntry } from "@/lib/team/rekey-payload";
import { encryptTeamAttachmentMode2 } from "@/lib/team/team-attachment-crypto";
import type { ItemEncryptionKeyInfo } from "@/lib/team/team-vault-core";

/**
 * Team attachment upload (docs/archive/review/team-key-rotation-rekey-plan.md
 * C4): always mode 2, under the entry's live ItemKey. A v0 entry is upgraded
 * first; a refusal saying the ItemKey moved under the request is retried once
 * with freshly read keys.
 */

export interface TeamAttachmentUploadDeps {
  teamId: string;
  entryId: string;
  /** The basePath-aware fetch (fetchApi). */
  fetchApi: (path: string, init?: RequestInit) => Promise<Response>;
  /** Reads the entry and resolves its live ItemKey (throws ItemKeyUpgradeRequiredError for v0). */
  getItemEncryptionKey: (teamId: string, entryId: string) => Promise<ItemEncryptionKeyInfo>;
  isUpgradeRequired: (e: unknown) => boolean;
  resolveKey: ResolveTeamKey;
  /** The team's current key version (the upgrade wraps under it). */
  currentTeamKeyVersion: () => Promise<number | null>;
}

export interface UploadFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

/** Thrown when a v0 entry cannot be upgraded (the response or reason is attached). */
export class TeamEntryUpgradeError extends Error {
  constructor(readonly response: Response | null) {
    super("Team entry upgrade failed");
    this.name = "TeamEntryUpgradeError";
  }
}

/** Upgrade a v0 entry to an ItemKey (v0→v1 PUT at the server's nextItemKeyVersion). */
export async function upgradeTeamEntry(deps: TeamAttachmentUploadDeps): Promise<void> {
  const res = await deps.fetchApi(apiPath.teamPasswordById(deps.teamId, deps.entryId));
  if (!res.ok) throw new TeamEntryUpgradeError(res);
  const raw = (await res.json()) as RekeySourceEntry & { nextItemKeyVersion: number };
  // Already upgraded by someone else since the caller looked.
  if (raw.itemKeyVersion >= 1) return;
  const current = await deps.currentTeamKeyVersion();
  if (current === null) throw new TeamEntryUpgradeError(null);
  const upgrade = await buildEntryUpgradePayload(
    deps.teamId,
    raw,
    raw.nextItemKeyVersion,
    current,
    deps.resolveKey,
  );
  if (upgrade.kind !== "payload") throw new TeamEntryUpgradeError(null);
  const put = await deps.fetchApi(apiPath.teamPasswordById(deps.teamId, deps.entryId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(upgrade.body),
  });
  if (!put.ok) throw new TeamEntryUpgradeError(put);
}

async function liveKeys(deps: TeamAttachmentUploadDeps): Promise<ItemEncryptionKeyInfo> {
  try {
    return await deps.getItemEncryptionKey(deps.teamId, deps.entryId);
  } catch (e) {
    if (!deps.isUpgradeRequired(e)) throw e;
    await upgradeTeamEntry(deps);
    return deps.getItemEncryptionKey(deps.teamId, deps.entryId);
  }
}

const RETRY_ONCE_CODES = new Set<string>([
  API_ERROR.ITEM_KEY_CHANGED,
  API_ERROR.CEK_KEY_VERSION_MISMATCH,
  API_ERROR.ENTRY_UPGRADE_REQUIRED,
]);

/**
 * Encrypt and upload one file as a mode-2 attachment. Returns the final
 * response (the caller reads the created row or the refusal).
 */
export async function uploadTeamAttachment(
  deps: TeamAttachmentUploadDeps,
  file: UploadFile,
): Promise<Response> {
  const plaintext = await file.arrayBuffer();
  for (let attempt = 0; ; attempt++) {
    const info = await liveKeys(deps);
    if (info.itemKeyId === null) {
      throw new Error("Entry ItemKey has no identity");
    }
    // The attachment id is bound into both AADs, so the client names it.
    const attachmentId = crypto.randomUUID();
    const sealed = await encryptTeamAttachmentMode2(plaintext, {
      teamId: deps.teamId,
      entryId: deps.entryId,
      attachmentId,
      itemKeyVersion: info.itemKeyVersion,
      cekWrapKey: info.keys.cekWrapKey,
    });

    const form = new FormData();
    form.append("id", attachmentId);
    form.append("file", new Blob([sealed.body.ciphertext as Uint8Array<ArrayBuffer>]));
    form.append("iv", sealed.body.iv);
    form.append("authTag", sealed.body.authTag);
    form.append("filename", file.name);
    form.append("contentType", file.type);
    form.append("sizeBytes", String(file.size));
    form.append("aadVersion", String(AAD_VERSION));
    form.append("encryptionMode", "2");
    form.append("itemKeyId", info.itemKeyId);
    form.append("cekKeyVersion", String(info.itemKeyVersion));
    form.append("cekEncrypted", sealed.cekEncrypted);
    form.append("cekIv", sealed.cekIv);
    form.append("cekAuthTag", sealed.cekAuthTag);
    form.append("cekWrapAadVersion", String(sealed.cekWrapAadVersion));

    const res = await deps.fetchApi(apiPath.teamPasswordAttachments(deps.teamId, deps.entryId), {
      method: "POST",
      body: form,
    });
    if (res.ok || attempt > 0) return res;
    const err = await readApiErrorBody(res.clone());
    if (!err || !RETRY_ONCE_CODES.has(err.error)) return res;
    // The ItemKey moved (re-key, restore, upgrade) under the upload: re-read
    // the entry (upgrading it again if a restore made it v0) and retry once.
  }
}
