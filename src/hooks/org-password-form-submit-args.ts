import type { SubmitOrgPasswordFormArgs } from "@/components/org/org-password-form-actions";
import type { EntryTypeValue } from "@/lib/constants";
import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";
import type { OrgEntryFieldValues } from "@/hooks/use-org-password-form-state";
type TFn = (key: string) => string;

interface BuildOrgPasswordSubmitArgsInput {
  orgId: string;
  isEdit: boolean;
  editData?: OrgPasswordFormEditData | null;
  effectiveEntryType: EntryTypeValue;
  cardNumberValid: boolean;
  isIdentity: boolean;
  t: TFn;
  ti: TFn;
  onSaved: () => void;
  handleOpenChange: (open: boolean) => void;
  values: OrgEntryFieldValues;
  setters: {
    setDobError: (value: string | null) => void;
    setExpiryError: (value: string | null) => void;
    setSaving: (value: boolean) => void;
  };
}

export function buildOrgPasswordSubmitArgs({
  orgId,
  isEdit,
  editData,
  effectiveEntryType,
  cardNumberValid,
  isIdentity,
  t,
  ti,
  onSaved,
  handleOpenChange,
  values,
  setters,
}: BuildOrgPasswordSubmitArgsInput): SubmitOrgPasswordFormArgs {
  return {
    orgId,
    isEdit,
    editData,
    effectiveEntryType,
    ...values,
    cardNumberValid,
    isIdentity,
    setDobError: setters.setDobError,
    setExpiryError: setters.setExpiryError,
    identityErrorCopy: {
      dobFuture: ti("dobFuture"),
      expiryBeforeIssue: ti("expiryBeforeIssue"),
    },
    t,
    setSaving: setters.setSaving,
    handleOpenChange,
    onSaved,
  };
}
