"use client";

import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { usePersonalFolders } from "@/hooks/use-personal-folders";
import type { PasswordFormProps } from "@/components/passwords/password-form-types";
import {
  buildPersonalPasswordFormController,
} from "@/hooks/personal-password-form-controller";
import {
  buildPersonalPasswordFormPresenter,
} from "@/hooks/personal-password-form-presenter";
import {
  toPersonalPasswordFormTranslations,
  useEntryFormTranslations,
} from "@/hooks/use-entry-form-translations";
import { usePersonalPasswordFormState } from "@/hooks/use-personal-password-form-state";

type PersonalPasswordFormModelInput = Pick<PasswordFormProps, "mode" | "initialData" | "onSaved" | "defaultFolderId" | "defaultTags">;

export function usePersonalPasswordFormModel({
  mode,
  initialData,
  onSaved,
  defaultFolderId,
  defaultTags,
}: PersonalPasswordFormModelInput) {
  const translationBundle = useEntryFormTranslations();
  const translations = toPersonalPasswordFormTranslations(translationBundle);
  const router = useRouter();
  const { encryptionKey, userId } = useVault();
  const formState = usePersonalPasswordFormState(initialData, { defaultFolderId, defaultTags });
  const { folders } = usePersonalFolders();

  const { values, hasChanges, loginMainFieldsProps } = buildPersonalPasswordFormPresenter({
    initialData,
    formState,
    translations,
    defaultFolderId,
    defaultTags,
  });
  const { handleSubmit, handleCancel, handleBack } = buildPersonalPasswordFormController({
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
