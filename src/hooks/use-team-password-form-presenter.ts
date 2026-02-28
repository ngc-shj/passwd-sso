"use client";

import { useMemo } from "react";
import { getTeamCardValidationState } from "@/components/team/team-credit-card-validation";
import { buildTeamEntryCopy } from "@/components/team/team-entry-copy";
import { buildTeamEntryCopyData } from "@/components/team/team-entry-copy-data";
import type { TeamEntryKindState } from "@/components/team/team-entry-kind";
import { buildTeamEntrySpecificFieldsPropsFromState } from "@/hooks/team-entry-specific-fields-props";
import {
  buildTeamCardNumberChangeCallback,
  buildTeamCardPresentationProps,
} from "@/hooks/team-password-form-presenter-card";
import {
  selectTeamEntryFieldValues,
  type TeamPasswordFormState,
} from "@/hooks/use-team-password-form-state";
import { buildGeneratorSummary } from "@/lib/generator-summary";
import type { TeamPasswordFormTranslations } from "@/hooks/entry-form-translations";

export interface TeamPasswordFormPresenterArgs {
  isEdit: boolean;
  entryKind: TeamEntryKindState["entryKind"];
  translations: TeamPasswordFormTranslations;
  formState: TeamPasswordFormState;
}

export function useTeamPasswordFormPresenter({
  isEdit,
  entryKind,
  translations,
  formState,
}: TeamPasswordFormPresenterArgs) {
  const { t, ti, tn, tcc, tpk, tba, tsl, tGen } = translations;
  const { values, setters } = formState;
  const entryValues = selectTeamEntryFieldValues(values);
  const {
    cardValidation,
    lengthHint,
    maxInputLength,
    showLengthError,
    showLuhnError,
    cardNumberValid,
    hasBrandHint,
  } = getTeamCardValidationState(values.cardNumber, values.brand);

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
      buildTeamEntryCopy({
        isEdit,
        entryKind,
        copyByKind: buildTeamEntryCopyData({ t, tn, tcc, ti, tpk, tba, tsl }),
      }),
    [isEdit, entryKind, t, tn, tcc, ti, tpk, tba, tsl],
  );

  const cardPresentation = buildTeamCardPresentationProps({
    cardValidation,
    hasBrandHint,
    tcc,
  });

  const entrySpecificFieldsProps = buildTeamEntrySpecificFieldsPropsFromState({
    entryKind,
    entryCopy,
    translations: { t, tn, tcc, ti, tpk, tba, tsl },
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
