import type { OrgPasswordFormControllerArgs } from "@/hooks/org-password-form-controller-args";
import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import type { OrgEntryFieldValues } from "@/hooks/use-org-password-form-state";

export type OrgPasswordFormDerivedArgs = Pick<
  OrgPasswordFormControllerArgs,
  "effectiveEntryType" | "editData"
> &
  OrgEntryKindState &
  OrgEntryFieldValues & {
  cardNumberValid: boolean;
};
