"use client";

import type { PersonalPasswordFormInitialData } from "@/components/passwords/password-form-types";
import {
  usePersonalPasswordFormDerived,
} from "@/hooks/use-personal-password-form-derived";
import {
  usePersonalEntryLoginFieldsProps,
} from "@/hooks/use-personal-entry-login-fields-props";
import type { PersonalPasswordFormState } from "@/hooks/use-personal-password-form-state";
import {
  selectPersonalEntryValues,
} from "@/hooks/use-personal-password-form-state";
import type { PersonalPasswordFormTranslations } from "@/hooks/use-entry-form-translations";

export interface PersonalPasswordFormPresenterArgs {
  initialData?: PersonalPasswordFormInitialData;
  formState: PersonalPasswordFormState;
  translations: PersonalPasswordFormTranslations;
}

export function usePersonalPasswordFormPresenter({
  initialData,
  formState,
  translations,
}: PersonalPasswordFormPresenterArgs) {
  const values = selectPersonalEntryValues(formState.values);
  const { hasChanges, generatorSummary } = usePersonalPasswordFormDerived({
    initialData,
    values,
    translations,
  });

  const loginMainFieldsProps = usePersonalEntryLoginFieldsProps({
    formState,
    generatorSummary,
    translations: { t: translations.t },
  });

  return {
    values,
    hasChanges,
    generatorSummary,
    loginMainFieldsProps,
  };
}
