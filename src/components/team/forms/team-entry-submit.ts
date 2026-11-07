import { toast } from "sonner";
import { saveTeamEntry } from "@/lib/team/team-entry-save";
import {
  generateItemKey,
  wrapItemKey,
  deriveItemEncryptionKey,
} from "@/lib/crypto/crypto-team";
import { buildItemKeyWrapAAD } from "@/lib/crypto/crypto-aad";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { readApiErrorBody } from "@/lib/http/read-api-error-body";
import type { EntryItemKeyData } from "@/lib/team/team-vault-core";
import type { TeamEntryFormEditData } from "@/components/team/forms/team-entry-form-types";
import type { EntryTypeValue } from "@/lib/constants";
import type { PasswordFormTranslator } from "@/lib/translation-types";

interface ExecuteTeamEntrySubmitArgs {
  teamId: string;
  isEdit: boolean;
  editData?: TeamEntryFormEditData | null;
  teamEncryptionKey: CryptoKey;
  teamKeyVersion: number;
  fullBlob: string;
  overviewBlob: string;
  entryType?: EntryTypeValue;
  tagIds: string[];
  teamFolderId?: string | null;
  requireReprompt?: boolean;
  expiresAt?: string | null;
  t: PasswordFormTranslator;
  setSaving: (value: boolean) => void;
  handleOpenChange: (open: boolean) => void;
  onSaved: () => void;
  /** Get ItemKey-derived encryption key for v>=1 entries (from TeamVaultContext) */
  getEntryDecryptionKey?: (teamId: string, entryId: string, entry: EntryItemKeyData) => Promise<CryptoKey>;
}

/** Wrapped ItemKey fields matching the server's encryptedFieldSchema */
interface WrappedItemKey {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/**
 * Generate a new ItemKey, wrap it with TeamKey, and derive the encryption key.
 */
async function generateAndWrapItemKey(
  teamId: string,
  entryId: string,
  teamEncryptionKey: CryptoKey,
  teamKeyVersion: number,
  itemKeyVersion: number,
): Promise<{
  encryptionKey: CryptoKey;
  itemKeyVersion: number;
  encryptedItemKey: WrappedItemKey;
}> {
  const rawItemKey = generateItemKey();
  try {
    const ikAad = buildItemKeyWrapAAD(teamId, entryId, teamKeyVersion);
    const wrapped = await wrapItemKey(rawItemKey, teamEncryptionKey, ikAad);
    const encryptionKey = await deriveItemEncryptionKey(rawItemKey);

    return {
      encryptionKey,
      itemKeyVersion,
      encryptedItemKey: {
        ciphertext: wrapped.ciphertext,
        iv: wrapped.iv,
        authTag: wrapped.authTag,
      },
    };
  } finally {
    rawItemKey.fill(0);
  }
}

export async function executeTeamEntrySubmit({
  teamId,
  isEdit,
  editData,
  teamEncryptionKey,
  teamKeyVersion,
  fullBlob,
  overviewBlob,
  entryType,
  tagIds,
  teamFolderId,
  requireReprompt,
  expiresAt,
  t,
  setSaving,
  handleOpenChange,
  onSaved,
  getEntryDecryptionKey,
}: ExecuteTeamEntrySubmitArgs): Promise<void> {
  setSaving(true);
  try {
    let encryptionKey: CryptoKey;
    let itemKeyVersion: number;
    let encryptedItemKey: WrappedItemKey | undefined;
    let itemKeyId: string | null | undefined;
    let snapshotBlobIv: string | undefined;
    let entryId: string;

    const existingItemKeyVersion = editData?.itemKeyVersion ?? 0;

    if (!isEdit) {
      // Create mode: always generate new ItemKey (a new entry's high-water is 0)
      entryId = crypto.randomUUID();
      const result = await generateAndWrapItemKey(teamId, entryId, teamEncryptionKey, teamKeyVersion, 1);
      encryptionKey = result.encryptionKey;
      itemKeyVersion = result.itemKeyVersion;
      encryptedItemKey = result.encryptedItemKey;
    } else if (existingItemKeyVersion >= 1 && editData) {
      // Edit mode (v>=1): reuse existing ItemKey and name it (C1)
      if (!getEntryDecryptionKey) {
        throw new Error("getEntryDecryptionKey is required for v>=1 entries");
      }
      entryId = editData.id;
      itemKeyId = editData.itemKeyId ?? null;
      encryptionKey = await getEntryDecryptionKey(teamId, entryId, {
        itemKeyVersion: editData.itemKeyVersion,
        encryptedItemKey: editData.encryptedItemKey,
        itemKeyIv: editData.itemKeyIv,
        itemKeyAuthTag: editData.itemKeyAuthTag,
        itemKeyId,
        teamKeyVersion: editData.teamKeyVersion ?? teamKeyVersion,
      });
      itemKeyVersion = existingItemKeyVersion;
      // Don't send encryptedItemKey — keep existing in DB
    } else {
      // Edit mode (v0): upgrade to an ItemKey at the server's next version,
      // naming the blob it replaces.
      if (!editData) throw new Error("editData is required in edit mode");
      entryId = editData.id;
      snapshotBlobIv = editData.blobIv;
      const result = await generateAndWrapItemKey(
        teamId,
        entryId,
        teamEncryptionKey,
        teamKeyVersion,
        editData.nextItemKeyVersion ?? 1,
      );
      encryptionKey = result.encryptionKey;
      itemKeyVersion = result.itemKeyVersion;
      encryptedItemKey = result.encryptedItemKey;
    }

    const res = await saveTeamEntry({
      mode: isEdit ? "edit" : "create",
      teamId,
      entryId,
      encryptionKey,
      teamKeyVersion,
      itemKeyVersion,
      encryptedItemKey,
      itemKeyId,
      snapshotBlobIv,
      fullBlob,
      overviewBlob,
      entryType,
      tagIds,
      teamFolderId,
      requireReprompt,
      expiresAt,
    });

    if (!res.ok) {
      const body = await readApiErrorBody(res);
      toast.error(saveErrorMessage(body?.error, t));
      setSaving(false);
      return;
    }

    toast.success(isEdit ? t("updated") : t("saved"));
    handleOpenChange(false);
    onSaved();
  } catch {
    toast.error(t("failedToSave"));
    setSaving(false);
  }
}

/**
 * The ItemKey refusals of a team entry save (C1) each say what to do: the
 * entry changed under the form (reopen it), it must be re-keyed first, or a
 * rotation changed the team key.
 */
function saveErrorMessage(code: string | undefined, t: PasswordFormTranslator): string {
  switch (code) {
    case API_ERROR.ITEM_KEY_CHANGED:
    case API_ERROR.ITEM_KEY_VERSION_INVALID:
      return t("teamEntryItemKeyChanged");
    case API_ERROR.ENTRY_REKEY_REQUIRED:
      return t("teamEntryRekeyRequired");
    case API_ERROR.TEAM_KEY_VERSION_MISMATCH:
      return t("teamEntryTeamKeyChanged");
    default:
      return t("failedToSave");
  }
}
