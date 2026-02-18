import { toast } from "sonner";
import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";
import { apiPath } from "@/lib/constants";

interface ExecuteOrgEntrySubmitArgs {
  orgId: string;
  isEdit: boolean;
  editData?: OrgPasswordFormEditData | null;
  body: unknown;
  t: (key: string) => string;
  setSaving: (value: boolean) => void;
  handleOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export async function executeOrgEntrySubmit({
  orgId,
  isEdit,
  editData,
  body,
  t,
  setSaving,
  handleOpenChange,
  onSaved,
}: ExecuteOrgEntrySubmitArgs): Promise<void> {
  setSaving(true);
  try {
    const endpoint = isEdit && editData
      ? apiPath.orgPasswordById(orgId, editData.id)
      : apiPath.orgPasswords(orgId);

    const res = await fetch(endpoint, {
      method: isEdit ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
