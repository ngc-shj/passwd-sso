"use client";

import { useMemo } from "react";
import { getOrgCardValidationState } from "@/components/team/team-credit-card-validation";
import { buildOrgEntryCopy } from "@/components/team/team-entry-copy";
import { buildOrgEntryCopyData } from "@/components/team/team-entry-copy-data";
import type { OrgEntryKindState } from "@/components/team/team-entry-kind";
import { buildTeamEntrySpecificFieldsPropsFromState } from "@/hooks/team-entry-specific-fields-props";
import {
  buildTeamCardNumberChangeCallback,
  buildTeamCardPresentationProps,
} from "@/hooks/team-password-form-presenter-card";
import {
  selectOrgEntryFieldValues,
  type TeamPasswordFormState,
} from "@/hooks/use-team-password-form-state";
import { buildGeneratorSummary } from "@/lib/generator-summary";
import type { TeamPasswordFormTranslations } from "@/hooks/entry-form-translations";

export interface TeamPasswordFormPresenterArgs {
  isEdit: boolean;
  entryKind: OrgEntryKindState["entryKind"];
  translations: TeamPasswordFormTranslations;
  formState: TeamPasswordFormState;
}

export function useTeamPasswordFormPresenter({
  isEdit,
  entryKind,
  translations,
  formState,
}: TeamPasswordFormPresenterArgs) {
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

  const handleCardNumberChange = buildTeamCardNumberChangeCallback(values, setters);

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

  const cardPresentation = buildTeamCardPresentationProps({
    cardValidation,
    hasBrandHint,
    tcc,
  });

  const entrySpecificFieldsProps = buildTeamEntrySpecificFieldsPropsFromState({
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
