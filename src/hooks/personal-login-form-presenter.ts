import type { PersonalLoginFormInitialData } from "@/components/passwords/personal-login-form-types";
import {
  buildPersonalLoginFormDerived,
} from "@/hooks/personal-login-form-derived";
import {
  buildPersonalLoginFieldsProps,
} from "@/hooks/personal-login-fields-props";
import type { PersonalLoginFormState } from "@/hooks/use-personal-login-form-state";
import {
  selectPersonalEntryValues,
} from "@/hooks/use-personal-login-form-state";
import type { PersonalPasswordFormTranslations } from "@/hooks/entry-form-translations";
import type { TagData } from "@/components/tags/tag-input";

export interface PersonalLoginFormPresenterArgs {
  initialData?: PersonalLoginFormInitialData;
  formState: PersonalLoginFormState;
  translations: PersonalPasswordFormTranslations;
  defaultFolderId?: string | null;
  defaultTags?: TagData[];
}

export function buildPersonalLoginFormPresenter({
  initialData,
  formState,
  translations,
  defaultFolderId,
  defaultTags,
}: PersonalLoginFormPresenterArgs) {
  const values = selectPersonalEntryValues(formState.values);
  const { hasChanges, generatorSummary } = buildPersonalLoginFormDerived({
    initialData,
    values,
    translations,
    defaultFolderId,
    defaultTags,
  });

  const loginMainFieldsProps = buildPersonalLoginFieldsProps({
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
