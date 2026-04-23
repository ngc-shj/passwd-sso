"use client";

import type { SubmitPersonalLoginFormArgs } from "@/components/passwords/personal-login-submit";
import type { PersonalLoginFormProps } from "@/components/passwords/personal-login-form-types";
import type { PersonalLoginFormTranslations } from "@/hooks/entry-form-translations";
import type { PersonalLoginFormEntryValues } from "@/hooks/personal/use-personal-login-form-state";
import type { PasswordFormRouter } from "@/hooks/password-form-router";

interface BuildPersonalLoginSubmitArgsParams {
  mode: Pick<PersonalLoginFormProps, "mode">["mode"];
  initialData: Pick<PersonalLoginFormProps, "initialData">["initialData"];
  onSaved: Pick<PersonalLoginFormProps, "onSaved">["onSaved"];
  encryptionKey: CryptoKey | null;
  userId: string | null;
  values: PersonalLoginFormEntryValues;
  setSubmitting: (value: boolean) => void;
  translations: PersonalLoginFormTranslations;
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
}: BuildPersonalLoginSubmitArgsParams): SubmitPersonalLoginFormArgs {
  return {
    mode,
    initialData,
    encryptionKey,
    userId,
    ...values,
    setSubmitting,
    t: translations.t,
    router,
    onSaved,
  };
}
