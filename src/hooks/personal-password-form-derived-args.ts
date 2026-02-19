import type { PersonalPasswordFormInitialData } from "@/components/passwords/password-form-types";
import type { PersonalPasswordFormTranslations } from "@/hooks/personal-password-form-translations";
import type { PersonalPasswordFormEntryValues } from "@/hooks/use-personal-password-form-state";

interface BuildPersonalPasswordDerivedArgsInput {
  initialData?: PersonalPasswordFormInitialData;
  values: PersonalPasswordFormEntryValues;
  translations: PersonalPasswordFormTranslations;
}

export function buildPersonalPasswordDerivedArgs({
  initialData,
  values,
  translations,
}: BuildPersonalPasswordDerivedArgsInput) {
  return {
    initialData,
    values,
    translations,
  };
}
