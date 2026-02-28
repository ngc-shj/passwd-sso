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
import type { PersonalPasswordFormTranslations } from "@/hooks/entry-form-translations";
import type { TagData } from "@/components/tags/tag-input";

export interface PersonalPasswordFormPresenterArgs {
  initialData?: PersonalPasswordFormInitialData;
  formState: PersonalPasswordFormState;
  translations: PersonalPasswordFormTranslations;
  defaultFolderId?: string | null;
  defaultTags?: TagData[];
}

export function buildPersonalPasswordFormPresenter({
  initialData,
  formState,
  translations,
  defaultFolderId,
  defaultTags,
}: PersonalPasswordFormPresenterArgs) {
  const values = selectPersonalEntryValues(formState.values);
  const { hasChanges, generatorSummary } = buildPersonalPasswordFormDerived({
    initialData,
    values,
    translations,
    defaultFolderId,
    defaultTags,
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
