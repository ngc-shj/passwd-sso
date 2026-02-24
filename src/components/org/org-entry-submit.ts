import { toast } from "sonner";
import { saveOrgEntry } from "@/lib/org-entry-save";
import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";
import type { EntryTypeValue } from "@/lib/constants";
import type { PasswordFormTranslator } from "@/lib/translation-types";

interface ExecuteOrgEntrySubmitArgs {
  orgId: string;
  isEdit: boolean;
  editData?: OrgPasswordFormEditData | null;
  orgEncryptionKey: CryptoKey;
  orgKeyVersion: number;
  fullBlob: string;
  overviewBlob: string;
  entryType?: EntryTypeValue;
  tagIds: string[];
  orgFolderId?: string | null;
  t: PasswordFormTranslator;
  setSaving: (value: boolean) => void;
  handleOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export async function executeOrgEntrySubmit({
  orgId,
  isEdit,
  editData,
  orgEncryptionKey,
  orgKeyVersion,
  fullBlob,
  overviewBlob,
  entryType,
  tagIds,
  orgFolderId,
  t,
  setSaving,
  handleOpenChange,
  onSaved,
}: ExecuteOrgEntrySubmitArgs): Promise<void> {
  setSaving(true);
  try {
    const res = await saveOrgEntry({
      mode: isEdit ? "edit" : "create",
      orgId,
      initialId: editData?.id,
      orgEncryptionKey,
      orgKeyVersion,
      fullBlob,
      overviewBlob,
      entryType,
      tagIds,
      orgFolderId,
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
