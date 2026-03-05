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
  SshKeyFormTranslator,
} from "@/lib/translation-types";

export interface PersonalLoginFormTranslations {
  t: PasswordFormTranslator;
  tGen: PasswordGeneratorTranslator;
  tc: CommonTranslator;
}

export interface TeamLoginFormTranslations {
  t: PasswordFormTranslator;
  tGen: PasswordGeneratorTranslator;
  tn: SecureNoteFormTranslator;
  tcc: CreditCardFormTranslator;
  ti: IdentityFormTranslator;
  tpk: PasskeyFormTranslator;
  tba: BankAccountFormTranslator;
  tsl: SoftwareLicenseFormTranslator;
  tsk: SshKeyFormTranslator;
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
  tsk: SshKeyFormTranslator;
}

export function toPersonalLoginFormTranslations(
  translations: EntryFormTranslationsBundle,
): PersonalLoginFormTranslations {
  return {
    t: translations.t,
    tGen: translations.tGen,
    tc: translations.tc,
  };
}

export function toTeamLoginFormTranslations(
  translations: EntryFormTranslationsBundle,
): TeamLoginFormTranslations {
  return {
    t: translations.t,
    tGen: translations.tGen,
    tn: translations.tn,
    tcc: translations.tcc,
    ti: translations.ti,
    tpk: translations.tpk,
    tba: translations.tba,
    tsl: translations.tsl,
    tsk: translations.tsk,
  };
}
