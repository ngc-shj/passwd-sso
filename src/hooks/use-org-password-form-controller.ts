"use client";

import { submitOrgPasswordForm } from "@/components/org/org-password-form-actions";
import type { OrgPasswordFormProps } from "@/components/org/org-password-form-types";
import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import type { EntryTypeValue } from "@/lib/constants";
import type { OrgPasswordFormTranslations } from "@/hooks/entry-form-translations";
import {
  useOrgPasswordFormPresenter,
} from "@/hooks/use-org-password-form-presenter";
import { useOrgPasswordFormDerived } from "@/hooks/use-org-password-form-derived";
import { type OrgPasswordFormState } from "@/hooks/use-org-password-form-state";
import { buildOrgSubmitArgs } from "@/hooks/org-password-form-submit-args";

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
  const { setters } = formState;
  const { entryValues, cardNumberValid, entryCopy, entrySpecificFieldsProps } =
    useOrgPasswordFormPresenter({
    isEdit,
    entryKind: entryKindState.entryKind,
    translations,
    formState,
  });

  const { hasChanges, submitDisabled } = useOrgPasswordFormDerived({
    effectiveEntryType,
    editData,
    entryKindState,
    entryValues,
    cardNumberValid,
  });

  const handleSubmit = async () => {
    const submitArgs = buildOrgSubmitArgs({
      orgId,
      onSaved,
      isEdit,
      editData,
      effectiveEntryType,
      entryKindState,
      translations,
      handleOpenChange,
      setters,
      entryValues,
      cardNumberValid,
    });
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
