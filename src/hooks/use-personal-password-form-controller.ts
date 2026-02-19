"use client";

import { submitPersonalPasswordForm } from "@/components/passwords/personal-password-submit";
import type { PersonalPasswordFormInitialData } from "@/components/passwords/password-form-types";
import type { PersonalPasswordFormEntryValues } from "@/hooks/use-personal-password-form-state";
import { buildPersonalPasswordSubmitArgs } from "@/hooks/personal-password-submit-args";
import type { PasswordFormTranslator } from "@/lib/translation-types";

interface UsePersonalPasswordFormControllerArgs {
  mode: "create" | "edit";
  initialData?: PersonalPasswordFormInitialData;
  onSaved?: () => void;
  encryptionKey: CryptoKey | null;
  userId?: string;
  values: PersonalPasswordFormEntryValues;
  setSubmitting: (value: boolean) => void;
  t: PasswordFormTranslator;
  router: { push: (href: string) => void; refresh: () => void; back: () => void };
}

export function usePersonalPasswordFormController({
  mode,
  initialData,
  onSaved,
  encryptionKey,
  userId,
  values,
  setSubmitting,
  t,
  router,
}: UsePersonalPasswordFormControllerArgs) {
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
        t,
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
