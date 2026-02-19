"use client";

import type { SubmitPersonalPasswordFormArgs } from "@/components/passwords/personal-password-submit";
import type { PasswordFormProps } from "@/components/passwords/password-form-types";
import type { PersonalPasswordFormTranslations } from "@/hooks/use-entry-form-translations";
import type { PersonalPasswordFormEntryValues } from "@/hooks/use-personal-password-form-state";
import type { PasswordFormRouter } from "@/hooks/password-form-router";

interface BuildPersonalSubmitArgsParams {
  mode: Pick<PasswordFormProps, "mode">["mode"];
  initialData: Pick<PasswordFormProps, "initialData">["initialData"];
  onSaved: Pick<PasswordFormProps, "onSaved">["onSaved"];
  encryptionKey: CryptoKey | null;
  userId?: string | null;
  values: PersonalPasswordFormEntryValues;
  setSubmitting: (value: boolean) => void;
  translations: PersonalPasswordFormTranslations;
  router: PasswordFormRouter;
}

export function buildPersonalSubmitArgs({
  mode,
  initialData,
  onSaved,
  encryptionKey,
  userId,
  values,
  setSubmitting,
  translations,
  router,
}: BuildPersonalSubmitArgsParams): SubmitPersonalPasswordFormArgs {
  return {
    mode,
    initialData,
    encryptionKey,
    userId: userId ?? undefined,
    ...values,
    setSubmitting,
    t: translations.t,
    router,
    onSaved,
  };
}
