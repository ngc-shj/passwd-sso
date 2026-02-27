import { toast } from "sonner";
import { saveTeamEntry } from "@/lib/team-entry-save";
import type { TeamPasswordFormEditData } from "@/components/team/team-password-form-types";
import type { EntryTypeValue } from "@/lib/constants";
import type { PasswordFormTranslator } from "@/lib/translation-types";

interface ExecuteTeamEntrySubmitArgs {
  teamId: string;
  isEdit: boolean;
  editData?: TeamPasswordFormEditData | null;
  teamEncryptionKey: CryptoKey;
  teamKeyVersion: number;
  fullBlob: string;
  overviewBlob: string;
  entryType?: EntryTypeValue;
  tagIds: string[];
  teamFolderId?: string | null;
  t: PasswordFormTranslator;
  setSaving: (value: boolean) => void;
  handleOpenChange: (open: boolean) => void;
  onSaved: () => void;
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
  t,
  setSaving,
  handleOpenChange,
  onSaved,
}: ExecuteTeamEntrySubmitArgs): Promise<void> {
  setSaving(true);
  try {
    const res = await saveTeamEntry({
      mode: isEdit ? "edit" : "create",
      teamId,
      initialId: editData?.id,
      teamEncryptionKey,
      teamKeyVersion,
      fullBlob,
      overviewBlob,
      entryType,
      tagIds,
      teamFolderId,
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
