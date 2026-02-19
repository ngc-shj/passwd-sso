"use client";

import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { usePersonalFolders } from "@/hooks/use-personal-folders";
import type { PasswordFormProps } from "@/components/passwords/password-form-types";
import {
  usePersonalPasswordFormController,
} from "@/hooks/use-personal-password-form-controller";
import { usePersonalPasswordFormDerived } from "@/hooks/use-personal-password-form-derived";
import {
  toPersonalPasswordFormTranslations,
  useEntryFormTranslations,
} from "@/hooks/use-entry-form-translations";
import {
  selectPersonalEntryValues,
  usePersonalPasswordFormState,
} from "@/hooks/use-personal-password-form-state";

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

  const values = selectPersonalEntryValues(formState.values);
  const { hasChanges, generatorSummary } = usePersonalPasswordFormDerived({
    initialData,
    values,
    translations,
  });
  const { handleSubmit, handleCancel, handleBack } = usePersonalPasswordFormController({
    mode,
    initialData,
    onSaved,
    encryptionKey,
    userId: userId ?? undefined,
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
    generatorSummary,
    handleSubmit,
    handleCancel,
    handleBack,
  };
}
