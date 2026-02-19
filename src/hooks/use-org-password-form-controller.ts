"use client";

import { submitOrgPasswordForm } from "@/components/org/org-password-form-actions";
import type { SubmitOrgPasswordFormArgs } from "@/components/org/org-password-form-actions";
import type { OrgPasswordFormProps } from "@/components/org/org-password-form-types";
import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import type { EntryTypeValue } from "@/lib/constants";
import {
  useOrgPasswordFormPresenter,
  type OrgPasswordFormTranslations,
} from "@/hooks/use-org-password-form-presenter";
import {
  useOrgPasswordFormDerived,
  type OrgPasswordFormDerivedArgs,
} from "@/hooks/use-org-password-form-derived";
import { selectOrgEntryFieldValues, type OrgPasswordFormState } from "@/hooks/use-org-password-form-state";

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
