import type { PasswordFormProps } from "@/components/passwords/password-form-types";
import type { PersonalPasswordFormTranslations } from "@/hooks/personal-password-form-translations";
import type { PersonalPasswordFormEntryValues } from "@/hooks/use-personal-password-form-state";

export interface PersonalPasswordFormControllerArgs {
  mode: Pick<PasswordFormProps, "mode">["mode"];
  initialData: Pick<PasswordFormProps, "initialData">["initialData"];
  onSaved: Pick<PasswordFormProps, "onSaved">["onSaved"];
  encryptionKey: CryptoKey | null;
  userId?: string;
  values: PersonalPasswordFormEntryValues;
  setSubmitting: (value: boolean) => void;
  translations: PersonalPasswordFormTranslations;
  router: { push: (href: string) => void; refresh: () => void; back: () => void };
}
