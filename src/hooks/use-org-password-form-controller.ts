"use client";

import { submitOrgPasswordForm } from "@/components/org/org-password-form-actions";
import { buildOrgPasswordDerivedArgs } from "@/hooks/org-password-form-derived-args";
import { buildOrgPasswordSubmitArgs } from "@/hooks/org-password-form-submit-args";
import { useOrgPasswordFormDerived } from "@/hooks/use-org-password-form-derived";
import { useOrgPasswordFormPresenter } from "@/hooks/use-org-password-form-presenter";
import {
  selectOrgEntryFieldValues,
  type OrgPasswordFormState,
} from "@/hooks/use-org-password-form-state";
import type { EntryTypeValue } from "@/lib/constants";
import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";
import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import type {
  CreditCardFormTranslator,
  IdentityFormTranslator,
  PasswordFormTranslator,
  PasswordGeneratorTranslator,
  PasskeyFormTranslator,
  SecureNoteFormTranslator,
} from "@/lib/translation-types";

type OrgFormState = OrgPasswordFormState;
interface OrgPasswordFormTranslations {
  t: PasswordFormTranslator;
  ti: IdentityFormTranslator;
  tn: SecureNoteFormTranslator;
  tcc: CreditCardFormTranslator;
  tpk: PasskeyFormTranslator;
  tGen: PasswordGeneratorTranslator;
}

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
  const { t, ti, tn, tcc, tpk, tGen } = translations;
  const { values, setters } = formState;
  const { entryKind, isIdentity } = entryKindState;
  const entryValues = selectOrgEntryFieldValues(values);
  const { cardNumberValid, entryCopy, entrySpecificFieldsProps } =
    useOrgPasswordFormPresenter({
      isEdit,
      entryKind,
      t,
      ti,
      tn,
      tcc,
      tpk,
      tGen,
      formState,
    });

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
        t,
        ti,
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
