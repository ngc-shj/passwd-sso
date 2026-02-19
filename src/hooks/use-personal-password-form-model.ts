"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { usePersonalFolders } from "@/hooks/use-personal-folders";
import type { PasswordFormProps } from "@/components/passwords/password-form-types";
import { usePersonalPasswordFormController } from "@/hooks/use-personal-password-form-controller";
import { usePersonalPasswordFormState } from "@/hooks/use-personal-password-form-state";

type PersonalPasswordFormModelInput = Pick<PasswordFormProps, "mode" | "initialData" | "onSaved">;

export function usePersonalPasswordFormModel({
  mode,
  initialData,
  onSaved,
}: PersonalPasswordFormModelInput) {
  const t = useTranslations("PasswordForm");
  const tGen = useTranslations("PasswordGenerator");
  const tc = useTranslations("Common");
  const router = useRouter();
  const { encryptionKey, userId } = useVault();
  const formState = usePersonalPasswordFormState(initialData);
  const {
    values: {
      showPassword,
      showGenerator,
      submitting,
      title,
      username,
      password,
      url,
      notes,
      selectedTags,
      generatorSettings,
      customFields,
      totp,
      showTotpInput,
      requireReprompt,
      folderId,
    },
    setters: {
      setShowPassword,
      setShowGenerator,
      setSubmitting,
      setTitle,
      setUsername,
      setPassword,
      setUrl,
      setNotes,
      setSelectedTags,
      setGeneratorSettings,
      setCustomFields,
      setTotp,
      setShowTotpInput,
      setRequireReprompt,
      setFolderId,
    },
  } = formState;
  const folders = usePersonalFolders();

  const values = {
    title,
    username,
    password,
    url,
    notes,
    selectedTags,
    generatorSettings,
    customFields,
    totp,
    requireReprompt,
    folderId,
  };
  const { hasChanges, generatorSummary, handleSubmit, handleCancel, handleBack } =
    usePersonalPasswordFormController({
      mode,
      initialData,
      onSaved,
      encryptionKey,
      userId: userId ?? undefined,
      values,
      setSubmitting,
      t,
      tGen,
      router,
    });

  return {
    t,
    tc,
    mode,
    submitting,
    title,
    username,
    password,
    url,
    notes,
    selectedTags,
    generatorSettings,
    customFields,
    totp,
    showTotpInput,
    requireReprompt,
    folderId,
    folders,
    showPassword,
    showGenerator,
    hasChanges,
    generatorSummary,
    setTitle,
    setUsername,
    setPassword,
    setUrl,
    setNotes,
    setSelectedTags,
    setGeneratorSettings,
    setCustomFields,
    setTotp,
    setShowTotpInput,
    setRequireReprompt,
    setFolderId,
    setShowPassword,
    setShowGenerator,
    handleSubmit,
    handleCancel,
    handleBack,
  };
}
