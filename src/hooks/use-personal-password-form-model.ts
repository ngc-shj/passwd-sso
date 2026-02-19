"use client";

import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { usePersonalFolders } from "@/hooks/use-personal-folders";
import type { PasswordFormProps } from "@/components/passwords/password-form-types";
import {
  usePersonalPasswordFormController,
} from "@/hooks/use-personal-password-form-controller";
import {
  usePersonalPasswordFormPresenter,
} from "@/hooks/use-personal-password-form-presenter";
import {
  toPersonalPasswordFormTranslations,
  useEntryFormTranslations,
} from "@/hooks/use-entry-form-translations";
import { usePersonalPasswordFormState } from "@/hooks/use-personal-password-form-state";

type PersonalPasswordFormModelInput = Pick<PasswordFormProps, "mode" | "initialData" | "onSaved">;

export function usePersonalPasswordFormModel({
  mode,
  initialData,
  onSaved,
}: PersonalPasswordFormModelInput) {
  const translationBundle = useEntryFormTranslations();
  const translations = toPersonalPasswordFormTranslations(translationBundle);
  const router = useRouter();
  const { encryptionKey, userId } = useVault();
  const formState = usePersonalPasswordFormState(initialData);
  const folders = usePersonalFolders();

  const { values, hasChanges, loginMainFieldsProps } = usePersonalPasswordFormPresenter({
    initialData,
    formState,
    translations,
  });
  const { handleSubmit, handleCancel, handleBack } = usePersonalPasswordFormController({
    mode,
    initialData,
    onSaved,
    encryptionKey,
    userId,
    values,
    setSubmitting: formState.setters.setSubmitting,
    translations,
    router,
  });

  return {
    t: translationBundle.t,
    tc: translationBundle.tc,
    mode,
    formState,
    folders,
    hasChanges,
    loginMainFieldsProps,
    handleSubmit,
    handleCancel,
    handleBack,
  };
}
