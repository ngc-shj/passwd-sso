import type {
  CreditCardFormTranslator,
  IdentityFormTranslator,
  PasswordFormTranslator,
  PasswordGeneratorTranslator,
  PasskeyFormTranslator,
  SecureNoteFormTranslator,
} from "@/lib/translation-types";

export interface OrgPasswordFormTranslations {
  t: PasswordFormTranslator;
  ti: IdentityFormTranslator;
  tn: SecureNoteFormTranslator;
  tcc: CreditCardFormTranslator;
  tpk: PasskeyFormTranslator;
  tGen: PasswordGeneratorTranslator;
}

export function buildOrgPasswordFormTranslations({
  t,
  ti,
  tn,
  tcc,
  tpk,
  tGen,
}: OrgPasswordFormTranslations): OrgPasswordFormTranslations {
  return { t, ti, tn, tcc, tpk, tGen };
}
