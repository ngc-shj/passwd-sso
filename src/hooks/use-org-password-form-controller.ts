"use client";

import { submitOrgPasswordForm } from "@/components/org/org-password-form-actions";
import type { OrgPasswordFormControllerArgs } from "@/hooks/org-password-form-controller-args";
import type { OrgPasswordFormDerivedArgs } from "@/hooks/org-password-form-derived-args";
import { buildOrgPasswordSubmitArgs } from "@/hooks/org-password-form-submit-args";
import { useOrgPasswordFormDerived } from "@/hooks/use-org-password-form-derived";
import { useOrgPasswordFormPresenter } from "@/hooks/use-org-password-form-presenter";
import { selectOrgEntryFieldValues } from "@/hooks/use-org-password-form-state";

export function useOrgPasswordFormController({
  orgId,
  onSaved,
  isEdit,
  editData,
  effectiveEntryType,
  entryKindState,
  translations,
  formState,
  handleOpenChange,
}: OrgPasswordFormControllerArgs) {
  const { values, setters } = formState;
  const { isIdentity } = entryKindState;
  const entryValues = selectOrgEntryFieldValues(values);
  const { cardNumberValid, entryCopy, entrySpecificFieldsProps } = useOrgPasswordFormPresenter({
    isEdit,
    entryKind: entryKindState.entryKind,
    ...translations,
    formState,
  });

  const derivedArgs: OrgPasswordFormDerivedArgs = {
    effectiveEntryType,
    editData,
    ...entryKindState,
    ...entryValues,
    cardNumberValid,
  };
  const { hasChanges, submitDisabled } = useOrgPasswordFormDerived(
    derivedArgs,
  );

  const handleSubmit = async () => {
    await submitOrgPasswordForm(
      buildOrgPasswordSubmitArgs({
        orgId,
        isEdit,
        editData,
        effectiveEntryType,
        cardNumberValid,
        isIdentity,
        translations,
        onSaved,
        handleOpenChange,
        values: entryValues,
        setters,
      }),
    );
  };

  return {
    entryCopy,
    entrySpecificFieldsProps,
    handleSubmit,
    hasChanges,
    submitDisabled,
  };
}
