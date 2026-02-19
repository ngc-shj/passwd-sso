import type { EntryTypeValue } from "@/lib/constants";
import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";
import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import type { OrgEntryFieldValues } from "@/hooks/use-org-password-form-state";

interface BuildOrgPasswordDerivedArgsInput {
  effectiveEntryType: EntryTypeValue;
  editData?: OrgPasswordFormEditData | null;
  entryKindState: OrgEntryKindState;
  values: OrgEntryFieldValues;
  cardNumberValid: boolean;
}

export interface OrgPasswordFormDerivedArgs extends OrgEntryKindState, OrgEntryFieldValues {
  effectiveEntryType: EntryTypeValue;
  editData?: OrgPasswordFormEditData | null;
  cardNumberValid: boolean;
}

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
