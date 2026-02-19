import type { OrgPasswordFormProps } from "@/components/org/org-password-form-types";
import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import type { EntryTypeValue } from "@/lib/constants";
import type { OrgPasswordFormTranslations } from "@/hooks/org-password-form-translations";
import type { OrgPasswordFormState } from "@/hooks/use-org-password-form-state";

export interface OrgPasswordFormControllerArgs {
  orgId: OrgPasswordFormProps["orgId"];
  onSaved: OrgPasswordFormProps["onSaved"];
  isEdit: boolean;
  editData?: OrgPasswordFormProps["editData"];
  effectiveEntryType: EntryTypeValue;
  entryKindState: OrgEntryKindState;
  translations: OrgPasswordFormTranslations;
  formState: OrgPasswordFormState;
  handleOpenChange: (open: boolean) => void;
}

export function buildOrgPasswordControllerArgs({
  orgId,
  onSaved,
  isEdit,
  editData,
  effectiveEntryType,
  entryKindState,
  translations,
  formState,
  handleOpenChange,
}: OrgPasswordFormControllerArgs): OrgPasswordFormControllerArgs {
  return {
    orgId,
    onSaved,
    isEdit,
    editData,
    effectiveEntryType,
    entryKindState,
    translations,
    formState,
    handleOpenChange,
  };
}
