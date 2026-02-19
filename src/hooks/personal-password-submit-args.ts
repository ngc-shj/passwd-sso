import { submitPersonalPasswordForm } from "@/components/passwords/personal-password-submit";
import type { PersonalPasswordFormInitialData } from "@/components/passwords/password-form-types";
import type { PersonalPasswordFormTranslations } from "@/hooks/personal-password-form-translations";
import type { PersonalPasswordFormEntryValues } from "@/hooks/use-personal-password-form-state";

interface BuildPersonalPasswordSubmitArgsInput {
  mode: "create" | "edit";
  initialData?: PersonalPasswordFormInitialData;
  encryptionKey: CryptoKey | null;
  userId?: string;
  values: PersonalPasswordFormEntryValues;
  setSubmitting: (value: boolean) => void;
  translations: PersonalPasswordFormTranslations;
  router: { push: (href: string) => void; refresh: () => void };
  onSaved?: () => void;
}

export function buildPersonalPasswordSubmitArgs({
  mode,
  initialData,
  encryptionKey,
  userId,
  values,
  setSubmitting,
  translations,
  router,
  onSaved,
}: BuildPersonalPasswordSubmitArgsInput): Parameters<typeof submitPersonalPasswordForm>[0] {
  const { t } = translations;
  return {
    mode,
    initialData,
    encryptionKey,
    userId: userId ?? undefined,
    title: values.title,
    username: values.username,
    password: values.password,
    url: values.url,
    notes: values.notes,
    selectedTags: values.selectedTags,
    generatorSettings: values.generatorSettings,
    customFields: values.customFields,
    totp: values.totp,
    requireReprompt: values.requireReprompt,
    folderId: values.folderId,
    setSubmitting,
    t,
    router,
    onSaved,
  };
}
