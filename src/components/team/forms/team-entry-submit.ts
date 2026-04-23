import { toast } from "sonner";
import { saveTeamEntry } from "@/lib/team/team-entry-save";
import {
  generateItemKey,
  wrapItemKey,
  deriveItemEncryptionKey,
} from "@/lib/crypto/crypto-team";
import { buildItemKeyWrapAAD } from "@/lib/crypto/crypto-aad";
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
  getEntryDecryptionKey?: (teamId: string, entryId: string, entry: {
    itemKeyVersion?: number;
    encryptedItemKey?: string;
    itemKeyIv?: string;
    itemKeyAuthTag?: string;
    teamKeyVersion: number;
  }) => Promise<CryptoKey>;
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
      itemKeyVersion: 1,
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
    let entryId: string;

    const existingItemKeyVersion = editData?.itemKeyVersion ?? 0;

    if (!isEdit) {
      // Create mode: always generate new ItemKey
      entryId = crypto.randomUUID();
      const result = await generateAndWrapItemKey(teamId, entryId, teamEncryptionKey, teamKeyVersion);
      encryptionKey = result.encryptionKey;
      itemKeyVersion = result.itemKeyVersion;
      encryptedItemKey = result.encryptedItemKey;
    } else if (existingItemKeyVersion >= 1 && editData) {
      // Edit mode (v>=1): reuse existing ItemKey
      if (!getEntryDecryptionKey) {
        throw new Error("getEntryDecryptionKey is required for v>=1 entries");
      }
      entryId = editData.id;
      encryptionKey = await getEntryDecryptionKey(teamId, entryId, {
        itemKeyVersion: editData.itemKeyVersion,
        encryptedItemKey: editData.encryptedItemKey,
        itemKeyIv: editData.itemKeyIv,
        itemKeyAuthTag: editData.itemKeyAuthTag,
        teamKeyVersion: editData.teamKeyVersion ?? teamKeyVersion,
      });
      itemKeyVersion = existingItemKeyVersion;
      // Don't send encryptedItemKey — keep existing in DB
    } else {
      // Edit mode (v0): upgrade to v1
      entryId = editData!.id;
      const result = await generateAndWrapItemKey(teamId, entryId, teamEncryptionKey, teamKeyVersion);
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
      fullBlob,
      overviewBlob,
      entryType,
      tagIds,
      teamFolderId,
      requireReprompt,
      expiresAt,
    });

    if (!res.ok) throw new Error("Failed");

    toast.success(isEdit ? t("updated") : t("saved"));
    handleOpenChange(false);
    onSaved();
  } catch {
    toast.error(t("failedToSave"));
    setSaving(false);
  }
}
