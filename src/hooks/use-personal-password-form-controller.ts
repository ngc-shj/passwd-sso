"use client";

import { submitPersonalPasswordForm } from "@/components/passwords/personal-password-submit";
import { createFormNavigationHandlers } from "@/components/passwords/form-navigation";
import type { PersonalPasswordFormControllerArgs } from "@/hooks/personal-password-form-controller-args";
import type { SubmitPersonalPasswordFormArgs } from "@/components/passwords/personal-password-submit";

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
    const submitArgs: SubmitPersonalPasswordFormArgs = {
      mode,
      initialData,
      encryptionKey,
      userId: userId ?? undefined,
      title: values.title,
      username: values.username,
      password: values.password,
      url: values.url,
      notes: values.notes,
      selectedTags: values.selectedTags,
      generatorSettings: values.generatorSettings,
      customFields: values.customFields,
      totp: values.totp,
      requireReprompt: values.requireReprompt,
      folderId: values.folderId,
      setSubmitting,
      t: translations.t,
      router,
      onSaved,
    };
    await submitPersonalPasswordForm(submitArgs);
  };

  return {
    handleSubmit,
    handleCancel,
    handleBack,
  };
}
