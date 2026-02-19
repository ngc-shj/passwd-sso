import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";
import type { OrgAttachmentMeta } from "@/components/org/org-attachment-section";
import { buildOrgPasswordFormInitialValues } from "@/hooks/org-password-form-initial-values";
import { useOrgPasswordFormUiState } from "@/hooks/use-org-password-form-ui-state";
import { useOrgPasswordFormValueState } from "@/hooks/use-org-password-form-value-state";

export function useOrgPasswordFormState(editData?: OrgPasswordFormEditData | null) {
  const initial = buildOrgPasswordFormInitialValues(editData);
  const uiState = useOrgPasswordFormUiState();
  const valueState = useOrgPasswordFormValueState(initial);

  const values = {
    ...uiState.values,
    ...valueState.values,
  };

  const setters = {
    ...uiState.setters,
    ...valueState.setters,
  };

  return { values, setters };
}

export type OrgPasswordFormState = ReturnType<typeof useOrgPasswordFormState>;
export type OrgPasswordFormValues = OrgPasswordFormState["values"];
export type OrgPasswordFormSettersState = OrgPasswordFormState["setters"];
export type OrgPasswordFormLifecycleSetters = OrgPasswordFormSettersState & {
  setAttachments: (value: OrgAttachmentMeta[]) => void;
};
export type { OrgEntryFieldValues } from "@/hooks/org-entry-field-values";
export { selectOrgEntryFieldValues } from "@/hooks/org-entry-field-values";
