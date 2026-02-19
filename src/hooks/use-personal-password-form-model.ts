"use client";

import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { buildPersonalPasswordDerivedArgs } from "@/hooks/personal-password-form-derived-args";
import type { PersonalPasswordFormTranslations } from "@/hooks/personal-password-form-translations";
import { usePersonalFolders } from "@/hooks/use-personal-folders";
import type { PasswordFormProps } from "@/components/passwords/password-form-types";
import { usePersonalPasswordFormController } from "@/hooks/use-personal-password-form-controller";
import { usePersonalPasswordFormDerived } from "@/hooks/use-personal-password-form-derived";
import { useEntryFormTranslations } from "@/hooks/use-entry-form-translations";
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
  const { t, tGen, tc } = useEntryFormTranslations();
  const translations: PersonalPasswordFormTranslations = { t, tGen, tc };
  const router = useRouter();
  const { encryptionKey, userId } = useVault();
  const formState = usePersonalPasswordFormState(initialData);
  const folders = usePersonalFolders();

  const values = selectPersonalEntryValues(formState.values);
  const { hasChanges, generatorSummary } = usePersonalPasswordFormDerived(
    buildPersonalPasswordDerivedArgs({
      initialData,
      values,
      translations,
    }),
  );
  const { handleSubmit, handleCancel, handleBack } =
    usePersonalPasswordFormController({
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
    t: translations.t,
    tc: translations.tc,
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
