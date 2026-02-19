"use client";

import { submitOrgPasswordForm } from "@/components/org/org-password-form-actions";
import { buildOrgPasswordDerivedArgs } from "@/hooks/org-password-form-derived-args";
import { buildOrgPasswordPresenterArgs } from "@/hooks/org-password-form-presenter-args";
import { buildOrgPasswordSubmitArgs } from "@/hooks/org-password-form-submit-args";
import type { OrgPasswordFormTranslations } from "@/hooks/org-password-form-translations";
import { useOrgPasswordFormDerived } from "@/hooks/use-org-password-form-derived";
import { useOrgPasswordFormPresenter } from "@/hooks/use-org-password-form-presenter";
import {
  selectOrgEntryFieldValues,
  type OrgPasswordFormState,
} from "@/hooks/use-org-password-form-state";
import type { EntryTypeValue } from "@/lib/constants";
import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";
import type { OrgEntryKindState } from "@/components/org/org-entry-kind";

type OrgFormState = OrgPasswordFormState;

interface UseOrgPasswordFormControllerArgs {
  orgId: string;
  onSaved: () => void;
  isEdit: boolean;
  editData?: OrgPasswordFormEditData | null;
  effectiveEntryType: EntryTypeValue;
  entryKindState: OrgEntryKindState;
  translations: OrgPasswordFormTranslations;
  formState: OrgFormState;
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
}: UseOrgPasswordFormControllerArgs) {
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

  const { hasChanges, submitDisabled } = useOrgPasswordFormDerived({
    ...buildOrgPasswordDerivedArgs({
      effectiveEntryType,
      editData,
      entryKindState,
      values: entryValues,
      cardNumberValid,
    }),
  });

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
