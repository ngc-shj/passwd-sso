"use client";

import type { SubmitPersonalPasswordFormArgs } from "@/components/passwords/personal-password-submit";
import type { PasswordFormProps } from "@/components/passwords/personal-password-form-types";
import type { PersonalPasswordFormTranslations } from "@/hooks/entry-form-translations";
import type { PersonalLoginFormEntryValues } from "@/hooks/use-personal-login-form-state";
import type { PasswordFormRouter } from "@/hooks/password-form-router";

interface BuildPersonalLoginSubmitArgsParams {
  mode: Pick<PasswordFormProps, "mode">["mode"];
  initialData: Pick<PasswordFormProps, "initialData">["initialData"];
  onSaved: Pick<PasswordFormProps, "onSaved">["onSaved"];
  encryptionKey: CryptoKey | null;
  userId?: string | null;
  values: PersonalLoginFormEntryValues;
  setSubmitting: (value: boolean) => void;
  translations: PersonalPasswordFormTranslations;
  router: PasswordFormRouter;
}

export function buildPersonalLoginSubmitArgs({
  mode,
  initialData,
  onSaved,
  encryptionKey,
  userId,
  values,
  setSubmitting,
  translations,
  router,
}: BuildPersonalLoginSubmitArgsParams): SubmitPersonalPasswordFormArgs {
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
