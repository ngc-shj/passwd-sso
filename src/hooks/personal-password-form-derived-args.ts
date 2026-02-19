import type { PersonalPasswordFormInitialData } from "@/components/passwords/password-form-types";
import type { PersonalPasswordFormTranslations } from "@/hooks/personal-password-form-translations";
import type { PersonalPasswordFormEntryValues } from "@/hooks/use-personal-password-form-state";

export interface PersonalPasswordFormDerivedArgs {
  initialData?: PersonalPasswordFormInitialData;
  values: PersonalPasswordFormEntryValues;
  translations: PersonalPasswordFormTranslations;
}

export function buildPersonalPasswordDerivedArgs({
  initialData,
  values,
  translations,
}: PersonalPasswordFormDerivedArgs): PersonalPasswordFormDerivedArgs {
  return {
    initialData,
    values,
    translations,
  };
}
