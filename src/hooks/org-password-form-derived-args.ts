import type { EntryTypeValue } from "@/lib/constants";
import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";
import type { OrgEntryFieldValues } from "@/hooks/use-org-password-form-state";

interface BuildOrgPasswordDerivedArgsInput {
  effectiveEntryType: EntryTypeValue;
  editData?: OrgPasswordFormEditData | null;
  isLoginEntry: boolean;
  isNote: boolean;
  isCreditCard: boolean;
  isIdentity: boolean;
  isPasskey: boolean;
  values: OrgEntryFieldValues;
  cardNumberValid: boolean;
}

export function buildOrgPasswordDerivedArgs({
  effectiveEntryType,
  editData,
  isLoginEntry,
  isNote,
  isCreditCard,
  isIdentity,
  isPasskey,
  values,
  cardNumberValid,
}: BuildOrgPasswordDerivedArgsInput) {
  return {
    effectiveEntryType,
    editData,
    isLoginEntry,
    isNote,
    isCreditCard,
    isIdentity,
    isPasskey,
    ...values,
    cardNumberValid,
  };
}
