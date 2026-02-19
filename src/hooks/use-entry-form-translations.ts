"use client";

import { useTranslations } from "next-intl";

export function useEntryFormTranslations() {
  const t = useTranslations("PasswordForm");
  const tGen = useTranslations("PasswordGenerator");
  const tc = useTranslations("Common");
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
