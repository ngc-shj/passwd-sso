import type { OrgPasswordFormControllerArgs } from "@/hooks/org-password-form-controller-args";
import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import type { OrgEntryFieldValues } from "@/hooks/use-org-password-form-state";

type BuildOrgPasswordDerivedArgsInput = Pick<
  OrgPasswordFormControllerArgs,
  "effectiveEntryType" | "editData" | "entryKindState"
> & {
  values: OrgEntryFieldValues;
  cardNumberValid: boolean;
};

export type OrgPasswordFormDerivedArgs = Pick<
  OrgPasswordFormControllerArgs,
  "effectiveEntryType" | "editData"
> &
  OrgEntryKindState &
  OrgEntryFieldValues & {
  cardNumberValid: boolean;
};

export function buildOrgPasswordDerivedArgs({
  effectiveEntryType,
  editData,
  entryKindState,
  values,
  cardNumberValid,
}: BuildOrgPasswordDerivedArgsInput): OrgPasswordFormDerivedArgs {
  return {
    effectiveEntryType,
    editData,
    ...entryKindState,
    ...values,
    cardNumberValid,
  };
}
