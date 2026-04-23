"use client";

import { useMemo } from "react";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault/vault-context";
import { usePersonalFolders } from "@/hooks/personal/use-personal-folders";
import type { PersonalLoginFormProps } from "@/components/passwords/personal-login-form-types";
import {
  buildPersonalLoginFormController,
} from "@/hooks/personal/personal-login-form-controller";
import {
  buildPersonalLoginFormPresenter,
} from "@/hooks/personal/personal-login-form-presenter";
import {
  toPersonalLoginFormTranslations,
  useEntryFormTranslations,
} from "@/hooks/form/use-entry-form-translations";
import { usePersonalLoginFormState } from "@/hooks/personal/use-personal-login-form-state";
import { getPolicyViolations } from "@/lib/security/password-policy-validation";
import { SYMBOL_GROUP_KEYS } from "@/lib/generator/generator-prefs";

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
  const { encryptionKey, userId, tenantPolicy } = useVault();
  const formState = usePersonalLoginFormState(initialData, { defaultFolderId, defaultTags });
  const { folders } = usePersonalFolders();

  const { values, hasChanges, loginMainFieldsProps } = buildPersonalLoginFormPresenter({
    initialData,
    formState,
    translations,
    defaultFolderId,
    defaultTags,
  });

  // Compute policy violations based on current generator settings against tenant policy.
  const generatorSettings = formState.values.generatorSettings;
  const policyViolations = useMemo(() => {
    const hasAnySymbolGroup = SYMBOL_GROUP_KEYS.some((key) => generatorSettings.symbolGroups[key]);
    return getPolicyViolations({ ...generatorSettings, hasAnySymbolGroup }, tenantPolicy);
  }, [generatorSettings, tenantPolicy]);

  const policyBlocked = policyViolations.length > 0;

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
    policyViolations,
    policyBlocked,
    handleSubmit,
    handleCancel,
    handleBack,
  };
}
