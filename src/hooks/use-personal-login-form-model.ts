"use client";

import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { usePersonalFolders } from "@/hooks/use-personal-folders";
import type { PersonalLoginFormProps } from "@/components/passwords/personal-login-form-types";
import {
  buildPersonalLoginFormController,
} from "@/hooks/personal-login-form-controller";
import {
  buildPersonalLoginFormPresenter,
} from "@/hooks/personal-login-form-presenter";
import {
  toPersonalLoginFormTranslations,
  useEntryFormTranslations,
} from "@/hooks/use-entry-form-translations";
import { usePersonalLoginFormState } from "@/hooks/use-personal-login-form-state";

type PersonalLoginFormModelInput = Pick<PersonalLoginFormProps, "mode" | "initialData" | "variant" | "onSaved" | "onCancel" | "defaultFolderId" | "defaultTags">;

export function usePersonalLoginFormModel({
  mode,
  initialData,
  variant,
  onSaved,
  onCancel,
  defaultFolderId,
  defaultTags,
}: PersonalLoginFormModelInput) {
  const translationBundle = useEntryFormTranslations();
  const translations = toPersonalLoginFormTranslations(translationBundle);
  const router = useRouter();
  const { encryptionKey, userId } = useVault();
  const formState = usePersonalLoginFormState(initialData, { defaultFolderId, defaultTags });
  const { folders } = usePersonalFolders();

  const { values, hasChanges, loginMainFieldsProps } = buildPersonalLoginFormPresenter({
    initialData,
    formState,
    translations,
    defaultFolderId,
    defaultTags,
  });
  const { handleSubmit, handleCancel, handleBack } = buildPersonalLoginFormController({
    mode,
    initialData,
    variant,
    onSaved,
    onCancel,
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
    ttm: translationBundle.ttm,
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
