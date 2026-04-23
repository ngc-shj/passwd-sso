import type { PersonalLoginFormProps } from "@/components/passwords/personal/personal-login-form-types";
import {
  submitPersonalLoginForm,
} from "@/components/passwords/personal/personal-login-submit";
import { createFormNavigationHandlers } from "@/components/passwords/shared/form-navigation";
import type { PersonalLoginFormEntryValues } from "@/hooks/personal/use-personal-login-form-state";
import type { PersonalLoginFormTranslations } from "@/hooks/form/entry-form-translations";
import { buildPersonalLoginSubmitArgs } from "@/hooks/personal/personal-login-form-submit-args";
import type { PasswordFormRouter } from "@/hooks/form/password-form-router";

export interface PersonalLoginFormControllerArgs {
  mode: Pick<PersonalLoginFormProps, "mode">["mode"];
  initialData: Pick<PersonalLoginFormProps, "initialData">["initialData"];
  variant?: Pick<PersonalLoginFormProps, "variant">["variant"];
  onSaved: Pick<PersonalLoginFormProps, "onSaved">["onSaved"];
  onCancel: Pick<PersonalLoginFormProps, "onCancel">["onCancel"];
  encryptionKey: CryptoKey | null;
  userId: string | null;
  values: PersonalLoginFormEntryValues;
  setSubmitting: (value: boolean) => void;
  translations: PersonalLoginFormTranslations;
  router: PasswordFormRouter;
}

export function buildPersonalLoginFormController({
  mode,
  initialData,
  variant,
  onSaved,
  onCancel,
  encryptionKey,
  userId,
  values,
  setSubmitting,
  translations,
  router,
}: PersonalLoginFormControllerArgs) {
  const { handleCancel, handleBack } = createFormNavigationHandlers({
    onCancel: variant === "dialog" ? onCancel : undefined,
    router,
  });

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
    await submitPersonalLoginForm(submitArgs);
  };

  return {
    handleSubmit,
    handleCancel,
    handleBack,
  };
}
