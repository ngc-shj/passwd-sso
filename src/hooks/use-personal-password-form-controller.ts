"use client";

import type { PasswordFormProps } from "@/components/passwords/password-form-types";
import {
  submitPersonalPasswordForm,
} from "@/components/passwords/personal-password-submit";
import { createFormNavigationHandlers } from "@/components/passwords/form-navigation";
import type { PersonalPasswordFormEntryValues } from "@/hooks/use-personal-password-form-state";
import type { PersonalPasswordFormTranslations } from "@/hooks/use-entry-form-translations";
import { buildPersonalSubmitArgs } from "@/hooks/personal-password-form-submit-args";
import type { PasswordFormRouter } from "@/hooks/password-form-router";

export interface PersonalPasswordFormControllerArgs {
  mode: Pick<PasswordFormProps, "mode">["mode"];
  initialData: Pick<PasswordFormProps, "initialData">["initialData"];
  onSaved: Pick<PasswordFormProps, "onSaved">["onSaved"];
  encryptionKey: CryptoKey | null;
  userId?: string | null;
  values: PersonalPasswordFormEntryValues;
  setSubmitting: (value: boolean) => void;
  translations: PersonalPasswordFormTranslations;
  router: PasswordFormRouter;
}

export function usePersonalPasswordFormController({
  mode,
  initialData,
  onSaved,
  encryptionKey,
  userId,
  values,
  setSubmitting,
  translations,
  router,
}: PersonalPasswordFormControllerArgs) {
  const { handleCancel, handleBack } = createFormNavigationHandlers({ onSaved, router });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const submitArgs = buildPersonalSubmitArgs({
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
