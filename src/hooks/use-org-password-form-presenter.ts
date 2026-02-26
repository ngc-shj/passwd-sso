"use client";

import { useMemo } from "react";
import { getOrgCardValidationState } from "@/components/team/team-credit-card-validation";
import { buildOrgEntryCopy } from "@/components/team/team-entry-copy";
import { buildOrgEntryCopyData } from "@/components/team/team-entry-copy-data";
import type { OrgEntryKindState } from "@/components/team/team-entry-kind";
import { buildOrgEntrySpecificFieldsPropsFromState } from "@/hooks/org-entry-specific-fields-props";
import {
  buildOrgCardNumberChangeCallback,
  buildOrgCardPresentationProps,
} from "@/hooks/org-password-form-presenter-card";
import {
  selectOrgEntryFieldValues,
  type OrgPasswordFormState,
} from "@/hooks/use-org-password-form-state";
import { buildGeneratorSummary } from "@/lib/generator-summary";
import type { OrgPasswordFormTranslations } from "@/hooks/entry-form-translations";

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

  const handleCardNumberChange = buildOrgCardNumberChangeCallback(values, setters);

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

  const cardPresentation = buildOrgCardPresentationProps({
    cardValidation,
    hasBrandHint,
    tcc,
  });

  const entrySpecificFieldsProps = buildOrgEntrySpecificFieldsPropsFromState({
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
    detectedBrand: cardPresentation.detectedBrand,
    hasBrandHint: cardPresentation.hasBrandHint,
    lengthHint,
  });

  return {
    entryValues,
    cardNumberValid,
    entryCopy,
    entrySpecificFieldsProps,
  };
}
