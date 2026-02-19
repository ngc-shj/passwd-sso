import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import type { OrgPasswordFormTranslations } from "@/hooks/org-password-form-translations";
import type { OrgPasswordFormState } from "@/hooks/use-org-password-form-state";
import type {
  CreditCardFormTranslator,
  IdentityFormTranslator,
  PasswordFormTranslator,
  PasswordGeneratorTranslator,
  PasskeyFormTranslator,
  SecureNoteFormTranslator,
} from "@/lib/translation-types";

export interface OrgPasswordFormPresenterArgsInput {
  isEdit: boolean;
  entryKindState: OrgEntryKindState;
  translations: OrgPasswordFormTranslations;
  formState: OrgPasswordFormState;
}

export interface OrgPasswordFormPresenterArgs {
  isEdit: boolean;
  entryKind: OrgEntryKindState["entryKind"];
  t: PasswordFormTranslator;
  ti: IdentityFormTranslator;
  tn: SecureNoteFormTranslator;
  tcc: CreditCardFormTranslator;
  tpk: PasskeyFormTranslator;
  tGen: PasswordGeneratorTranslator;
  formState: OrgPasswordFormState;
}

export function buildOrgPasswordPresenterArgs({
  isEdit,
  entryKindState,
  translations,
  formState,
}: OrgPasswordFormPresenterArgsInput): OrgPasswordFormPresenterArgs {
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
