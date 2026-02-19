"use client";

import { submitOrgPasswordForm } from "@/components/org/org-password-form-actions";
import type { OrgPasswordFormControllerArgs } from "@/hooks/org-password-form-controller-args";
import type { SubmitOrgPasswordFormArgs } from "@/components/org/org-password-form-actions";
import {
  useOrgPasswordFormDerived,
  type OrgPasswordFormDerivedArgs,
} from "@/hooks/use-org-password-form-derived";
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
    const submitArgs: SubmitOrgPasswordFormArgs = {
      orgId,
      isEdit,
      editData,
      effectiveEntryType,
      ...entryValues,
      cardNumberValid,
      isIdentity,
      setDobError: setters.setDobError,
      setExpiryError: setters.setExpiryError,
      identityErrorCopy: {
        dobFuture: translations.ti("dobFuture"),
        expiryBeforeIssue: translations.ti("expiryBeforeIssue"),
      },
      t: translations.t,
      setSaving: setters.setSaving,
      handleOpenChange,
      onSaved,
    };
    await submitOrgPasswordForm(submitArgs);
  };

  return {
    entryCopy,
    entrySpecificFieldsProps,
    handleSubmit,
    hasChanges,
    submitDisabled,
  };
}
