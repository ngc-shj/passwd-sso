import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import type { OrgPasswordFormState } from "@/hooks/use-org-password-form-state";
import type {
  CreditCardFormTranslator,
  IdentityFormTranslator,
  PasswordFormTranslator,
  PasswordGeneratorTranslator,
  PasskeyFormTranslator,
  SecureNoteFormTranslator,
} from "@/lib/translation-types";

interface OrgPasswordFormTranslations {
  t: PasswordFormTranslator;
  ti: IdentityFormTranslator;
  tn: SecureNoteFormTranslator;
  tcc: CreditCardFormTranslator;
  tpk: PasskeyFormTranslator;
  tGen: PasswordGeneratorTranslator;
}

interface BuildOrgPasswordPresenterArgsInput {
  isEdit: boolean;
  entryKindState: OrgEntryKindState;
  translations: OrgPasswordFormTranslations;
  formState: OrgPasswordFormState;
}

export function buildOrgPasswordPresenterArgs({
  isEdit,
  entryKindState,
  translations,
  formState,
}: BuildOrgPasswordPresenterArgsInput) {
  const { t, ti, tn, tcc, tpk, tGen } = translations;

  return {
    isEdit,
    entryKind: entryKindState.entryKind,
    t,
    ti,
    tn,
    tcc,
    tpk,
    tGen,
    formState,
  };
}
