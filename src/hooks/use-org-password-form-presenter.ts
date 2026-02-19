"use client";

import { useMemo } from "react";
import { getOrgCardValidationState } from "@/components/org/org-credit-card-validation";
import { buildOrgEntryCopy } from "@/components/org/org-entry-copy";
import { buildOrgEntryCopyData } from "@/components/org/org-entry-copy-data";
import { handleOrgCardNumberChange } from "@/components/org/org-password-form-actions";
import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import { useOrgEntrySpecificFieldsPropsFromState } from "@/hooks/use-org-entry-specific-fields-props";
import type { OrgPasswordFormState } from "@/hooks/use-org-password-form-state";
import { buildGeneratorSummary } from "@/lib/generator-summary";
import type { OrgPasswordFormTranslations } from "@/hooks/use-entry-form-translations";

export interface OrgPasswordFormPresenterArgs {
  isEdit: boolean;
  entryKind: OrgEntryKindState["entryKind"];
  translations: OrgPasswordFormTranslations;
  formState: OrgPasswordFormState;
}

export function useOrgPasswordFormPresenter({
  isEdit,
  entryKind,
  translations,
  formState,
}: OrgPasswordFormPresenterArgs) {
  const { t, ti, tn, tcc, tpk, tGen } = translations;
  const { values, setters } = formState;
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

  const entrySpecificFieldsProps = useOrgEntrySpecificFieldsPropsFromState({
    entryKind,
    entryCopy,
    translations: { t, tn, tcc, ti, tpk },
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
    cardNumberValid,
    entryCopy,
    entrySpecificFieldsProps,
  };
}
