import type { PersonalLoginFormProps } from "@/components/passwords/personal-login-form-types";
import {
  submitPersonalPasswordForm,
} from "@/components/passwords/personal-password-submit";
import { createFormNavigationHandlers } from "@/components/passwords/form-navigation";
import type { PersonalLoginFormEntryValues } from "@/hooks/use-personal-login-form-state";
import type { PersonalPasswordFormTranslations } from "@/hooks/entry-form-translations";
import { buildPersonalLoginSubmitArgs } from "@/hooks/personal-login-form-submit-args";
import type { PasswordFormRouter } from "@/hooks/password-form-router";

export interface PersonalLoginFormControllerArgs {
  mode: Pick<PersonalLoginFormProps, "mode">["mode"];
  initialData: Pick<PersonalLoginFormProps, "initialData">["initialData"];
  onSaved: Pick<PersonalLoginFormProps, "onSaved">["onSaved"];
  encryptionKey: CryptoKey | null;
  userId?: string | null;
  values: PersonalLoginFormEntryValues;
  setSubmitting: (value: boolean) => void;
  translations: PersonalPasswordFormTranslations;
  router: PasswordFormRouter;
}

export function buildPersonalLoginFormController({
  mode,
  initialData,
  onSaved,
  encryptionKey,
  userId,
  values,
  setSubmitting,
  translations,
  router,
}: PersonalLoginFormControllerArgs) {
  const { handleCancel, handleBack } = createFormNavigationHandlers({ onSaved, router });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const submitArgs = buildPersonalLoginSubmitArgs({
      mode,
      initialData,
      onSaved,
      encryptionKey,
      userId,
      values,
      setSubmitting,
      translations,
      router,
    });
    await submitPersonalPasswordForm(submitArgs);
  };

  return {
    handleSubmit,
    handleCancel,
    handleBack,
  };
}
