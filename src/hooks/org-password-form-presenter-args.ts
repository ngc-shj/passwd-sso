import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import type { OrgPasswordFormTranslations } from "@/hooks/org-password-form-translations";
import type { OrgPasswordFormState } from "@/hooks/use-org-password-form-state";

export type OrgPasswordFormPresenterArgsInput = {
  isEdit: boolean;
  entryKindState: OrgEntryKindState;
  translations: OrgPasswordFormTranslations;
  formState: OrgPasswordFormState;
};

export type OrgPasswordFormPresenterArgs = OrgPasswordFormTranslations & {
  isEdit: boolean;
  entryKind: OrgEntryKindState["entryKind"];
  formState: OrgPasswordFormState;
};

export function buildOrgPasswordPresenterArgs({
  isEdit,
  entryKindState,
  translations,
  formState,
}: OrgPasswordFormPresenterArgsInput): OrgPasswordFormPresenterArgs {
  return {
    isEdit,
    entryKind: entryKindState.entryKind,
    ...translations,
    formState,
  };
}
