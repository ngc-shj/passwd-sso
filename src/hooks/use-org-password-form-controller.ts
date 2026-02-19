"use client";

import { useMemo } from "react";
import { getOrgCardValidationState } from "@/components/org/org-credit-card-validation";
import { buildOrgEntryCopy } from "@/components/org/org-entry-copy";
import { buildOrgEntryCopyData } from "@/components/org/org-entry-copy-data";
import {
  handleOrgCardNumberChange,
  submitOrgPasswordForm,
} from "@/components/org/org-password-form-actions";
import { buildOrgPasswordSubmitArgs } from "@/hooks/org-password-form-submit-args";
import { useOrgEntrySpecificFieldsPropsFromState } from "@/hooks/use-org-entry-specific-fields-props";
import { useOrgPasswordFormDerived } from "@/hooks/use-org-password-form-derived";
import { buildGeneratorSummary } from "@/lib/generator-summary";
import {
  selectOrgEntryFieldValues,
  type OrgPasswordFormState,
} from "@/hooks/use-org-password-form-state";
import type { EntryTypeValue } from "@/lib/constants";
import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";

type TFn = (key: string, values?: Record<string, string | number | Date>) => string;
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
  t: TFn;
  ti: TFn;
  tn: TFn;
  tcc: TFn;
  tpk: TFn;
  tGen: TFn;
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
  const {
    cardValidation,
    lengthHint,
    maxInputLength,
    showLengthError,
    showLuhnError,
    cardNumberValid,
    hasBrandHint,
  } = getOrgCardValidationState(values.cardNumber, values.brand);

  const handleCardNumberChange = (value: string) => {
    handleOrgCardNumberChange({
      value,
      brand: values.brand,
      brandSource: values.brandSource,
      setCardNumber: setters.setCardNumber,
      setBrand: setters.setBrand,
    });
  };

  const handleSubmit = async () => {
    await submitOrgPasswordForm(
      buildOrgPasswordSubmitArgs({
        orgId,
        isEdit,
        editData,
        effectiveEntryType,
        cardNumberValid,
        isIdentity,
        t: (key) => t(key),
        ti: (key) => ti(key),
        onSaved,
        handleOpenChange,
        values: entryValues,
        setters,
      }),
    );
  };

  const generatorSummary = useMemo(
    () =>
      buildGeneratorSummary(values.generatorSettings, {
        modePassphrase: tGen("modePassphrase"),
        modePassword: tGen("modePassword"),
      }),
    [values.generatorSettings, tGen],
  );

  const entryCopy = useMemo(
    () =>
      buildOrgEntryCopy({
        isEdit,
        entryKind,
        copyByKind: buildOrgEntryCopyData({ t, tn, tcc, ti, tpk }),
      }),
    [isEdit, entryKind, t, tn, tcc, ti, tpk],
  );

  const { hasChanges, submitDisabled } = useOrgPasswordFormDerived({
    effectiveEntryType,
    editData,
    isLoginEntry,
    isNote,
    isCreditCard,
    isIdentity,
    isPasskey,
    ...entryValues,
    cardNumberValid,
  });

  const entrySpecificFieldsProps = useOrgEntrySpecificFieldsPropsFromState({
    entryKind,
    entryCopy,
    t,
    tn,
    tcc,
    ti,
    tpk,
    values,
    setters,
    generatorSummary,
    onCardNumberChange: handleCardNumberChange,
    maxInputLength,
    showLengthError,
    showLuhnError,
    detectedBrand: cardValidation.detectedBrand
      ? tcc("cardNumberDetectedBrand", { brand: cardValidation.detectedBrand })
      : undefined,
    hasBrandHint: hasBrandHint && cardValidation.digits.length > 0,
    lengthHint,
  });

  return {
    entryCopy,
    entrySpecificFieldsProps,
    handleSubmit,
    hasChanges,
    submitDisabled,
  };
}
