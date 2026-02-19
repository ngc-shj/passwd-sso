"use client";

import { submitPersonalPasswordForm } from "@/components/passwords/personal-password-submit";
import { createFormNavigationHandlers } from "@/components/passwords/form-navigation";
import { buildPersonalPasswordSubmitArgs } from "@/hooks/personal-password-submit-args";
import type { PersonalPasswordFormControllerArgs } from "@/hooks/personal-password-form-controller-args";

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
    await submitPersonalPasswordForm(
      buildPersonalPasswordSubmitArgs({
        mode,
        initialData,
        encryptionKey,
        userId,
        values,
        setSubmitting,
        translations,
        router,
        onSaved,
      }),
    );
  };

  return {
    handleSubmit,
    handleCancel,
    handleBack,
  };
}
