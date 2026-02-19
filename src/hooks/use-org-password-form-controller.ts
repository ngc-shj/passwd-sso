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
import type {
  CreditCardFormTranslator,
  IdentityFormTranslator,
  PasswordFormTranslator,
  PasswordGeneratorTranslator,
  PasskeyFormTranslator,
  SecureNoteFormTranslator,
} from "@/lib/translation-types";

type OrgFormState = OrgPasswordFormState;

interface UseOrgPasswordFormControllerArgs {
  orgId: string;
  onSaved: () => void;
  isEdit: boolean;
  editData?: OrgPasswordFormEditData | null;
  effectiveEntryType: EntryTypeValue;
  entryKind: "password" | "secureNote" | "creditCard" | "identity" | "passkey";
  isLoginEntry: boolean;
  isNote: boolean;
  isCreditCard: boolean;
  isIdentity: boolean;
  isPasskey: boolean;
  t: PasswordFormTranslator;
  ti: IdentityFormTranslator;
  tn: SecureNoteFormTranslator;
  tcc: CreditCardFormTranslator;
  tpk: PasskeyFormTranslator;
  tGen: PasswordGeneratorTranslator;
  formState: OrgFormState;
  handleOpenChange: (open: boolean) => void;
}

export function useOrgPasswordFormController({
  orgId,
  onSaved,
  isEdit,
  editData,
  effectiveEntryType,
  entryKind,
  isLoginEntry,
  isNote,
  isCreditCard,
  isIdentity,
  isPasskey,
  t,
  ti,
  tn,
  tcc,
  tpk,
  tGen,
  formState,
  handleOpenChange,
}: UseOrgPasswordFormControllerArgs) {
  const { values, setters } = formState;
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
      isLoginEntry,
      isNote,
      isCreditCard,
      isIdentity,
      isPasskey,
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
