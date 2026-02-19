"use client";

import { useTranslations } from "next-intl";
import type {
  CommonTranslator,
  PasswordFormTranslator,
  PasswordGeneratorTranslator,
} from "@/lib/translation-types";

export function useEntryFormTranslations() {
  const t: PasswordFormTranslator = useTranslations("PasswordForm");
  const tGen: PasswordGeneratorTranslator = useTranslations("PasswordGenerator");
  const tc: CommonTranslator = useTranslations("Common");
  const tn = useTranslations("SecureNoteForm");
  const tcc = useTranslations("CreditCardForm");
  const ti = useTranslations("IdentityForm");
  const tpk = useTranslations("PasskeyForm");

  return {
    t,
    tGen,
    tc,
    tn,
    tcc,
    ti,
    tpk,
  };
}
