import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import type { OrgPasswordFormTranslations } from "@/hooks/org-password-form-translations";
import type { OrgPasswordFormState } from "@/hooks/use-org-password-form-state";

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
