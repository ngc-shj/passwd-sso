"use client";

import { useTranslations } from "next-intl";
import type {
  PasswordFormTranslator,
  PasswordGeneratorTranslator,
} from "@/lib/translation-types";
import type { EntryFormTranslationsBundle } from "@/hooks/entry-form-translations";

export {
  toPersonalPasswordFormTranslations,
  toTeamPasswordFormTranslations,
} from "@/hooks/entry-form-translations";

export function useEntryFormTranslations() {
  const t: PasswordFormTranslator = useTranslations("PasswordForm");
  const tGen: PasswordGeneratorTranslator = useTranslations("PasswordGenerator");
  const tc = useTranslations("Common");
  const tn = useTranslations("SecureNoteForm");
  const tcc = useTranslations("CreditCardForm");
  const ti = useTranslations("IdentityForm");
  const tpk = useTranslations("PasskeyForm");
  const tba = useTranslations("BankAccountForm");
  const tsl = useTranslations("SoftwareLicenseForm");

  return {
    t,
    tGen,
    tc,
    tn,
    tcc,
    ti,
    tpk,
    tba,
    tsl,
  } satisfies EntryFormTranslationsBundle;
}
