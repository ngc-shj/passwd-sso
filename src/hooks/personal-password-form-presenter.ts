import type { PersonalPasswordFormInitialData } from "@/components/passwords/password-form-types";
import {
  buildPersonalPasswordFormDerived,
} from "@/hooks/personal-password-form-derived";
import {
  buildPersonalEntryLoginFieldsProps,
} from "@/hooks/personal-entry-login-fields-props";
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

export function buildPersonalPasswordFormPresenter({
  initialData,
  formState,
  translations,
}: PersonalPasswordFormPresenterArgs) {
  const values = selectPersonalEntryValues(formState.values);
  const { hasChanges, generatorSummary } = buildPersonalPasswordFormDerived({
    initialData,
    values,
    translations,
  });

  const loginMainFieldsProps = buildPersonalEntryLoginFieldsProps({
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
