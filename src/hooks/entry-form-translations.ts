import type {
  BankAccountFormTranslator,
  CommonTranslator,
  CreditCardFormTranslator,
  IdentityFormTranslator,
  PasswordFormTranslator,
  PasswordGeneratorTranslator,
  PasskeyFormTranslator,
  SecureNoteFormTranslator,
  SoftwareLicenseFormTranslator,
} from "@/lib/translation-types";

export interface PersonalPasswordFormTranslations {
  t: PasswordFormTranslator;
  tGen: PasswordGeneratorTranslator;
  tc: CommonTranslator;
}

export interface TeamPasswordFormTranslations {
  t: PasswordFormTranslator;
  tGen: PasswordGeneratorTranslator;
  tn: SecureNoteFormTranslator;
  tcc: CreditCardFormTranslator;
  ti: IdentityFormTranslator;
  tpk: PasskeyFormTranslator;
  tba: BankAccountFormTranslator;
  tsl: SoftwareLicenseFormTranslator;
}

export interface EntryFormTranslationsBundle {
  t: PasswordFormTranslator;
  tGen: PasswordGeneratorTranslator;
  tc: CommonTranslator;
  tn: SecureNoteFormTranslator;
  tcc: CreditCardFormTranslator;
  ti: IdentityFormTranslator;
  tpk: PasskeyFormTranslator;
  tba: BankAccountFormTranslator;
  tsl: SoftwareLicenseFormTranslator;
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

export function toTeamPasswordFormTranslations(
  translations: EntryFormTranslationsBundle,
): TeamPasswordFormTranslations {
  return {
    t: translations.t,
    tGen: translations.tGen,
    tn: translations.tn,
    tcc: translations.tcc,
    ti: translations.ti,
    tpk: translations.tpk,
    tba: translations.tba,
    tsl: translations.tsl,
  };
}
