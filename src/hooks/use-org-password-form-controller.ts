"use client";

import { submitOrgPasswordForm } from "@/components/org/org-password-form-actions";
import type { OrgPasswordFormControllerArgs } from "@/hooks/org-password-form-controller-args";
import { buildOrgPasswordDerivedArgs } from "@/hooks/org-password-form-derived-args";
import { buildOrgPasswordPresenterArgs } from "@/hooks/org-password-form-presenter-args";
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
  const { cardNumberValid, entryCopy, entrySpecificFieldsProps } =
    useOrgPasswordFormPresenter(
      buildOrgPasswordPresenterArgs({
        isEdit,
        entryKindState,
        translations,
        formState,
      }),
    );

  const { hasChanges, submitDisabled } = useOrgPasswordFormDerived(
    buildOrgPasswordDerivedArgs({
      effectiveEntryType,
      editData,
      entryKindState,
      values: entryValues,
      cardNumberValid,
    }),
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
