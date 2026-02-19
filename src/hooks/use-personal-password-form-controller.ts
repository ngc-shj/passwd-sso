"use client";

import { submitPersonalPasswordForm } from "@/components/passwords/personal-password-submit";
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

  const handleCancel = () => {
    if (onSaved) {
      onSaved();
      return;
    }
    router.back();
  };

  const handleBack = () => {
    router.back();
  };

  return {
    handleSubmit,
    handleCancel,
    handleBack,
  };
}
