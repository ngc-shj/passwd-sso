"use client";

import { useTranslations } from "next-intl";
import type {
  CommonTranslator,
  CreditCardFormTranslator,
  IdentityFormTranslator,
  PasswordFormTranslator,
  PasswordGeneratorTranslator,
  PasskeyFormTranslator,
  SecureNoteFormTranslator,
} from "@/lib/translation-types";

export interface PersonalPasswordFormTranslations {
  t: PasswordFormTranslator;
  tGen: PasswordGeneratorTranslator;
  tc: CommonTranslator;
}

export interface OrgPasswordFormTranslations {
  t: PasswordFormTranslator;
  tGen: PasswordGeneratorTranslator;
  tn: SecureNoteFormTranslator;
  tcc: CreditCardFormTranslator;
  ti: IdentityFormTranslator;
  tpk: PasskeyFormTranslator;
}

export interface EntryFormTranslationsBundle {
  t: PasswordFormTranslator;
  tGen: PasswordGeneratorTranslator;
  tc: CommonTranslator;
  tn: SecureNoteFormTranslator;
  tcc: CreditCardFormTranslator;
  ti: IdentityFormTranslator;
  tpk: PasskeyFormTranslator;
}

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
  } satisfies EntryFormTranslationsBundle;
}

export function toPersonalPasswordFormTranslations(
  translations: EntryFormTranslationsBundle,
): PersonalPasswordFormTranslations {
  return {
    t: translations.t,
    tGen: translations.tGen,
    tc: translations.tc,
  };
}

export function toOrgPasswordFormTranslations(
  translations: EntryFormTranslationsBundle,
): OrgPasswordFormTranslations {
  return {
    t: translations.t,
    tGen: translations.tGen,
    tn: translations.tn,
    tcc: translations.tcc,
    ti: translations.ti,
    tpk: translations.tpk,
  };
}
