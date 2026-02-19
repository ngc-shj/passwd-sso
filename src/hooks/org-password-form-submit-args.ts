import type { SubmitOrgPasswordFormArgs } from "@/components/org/org-password-form-actions";
import type { OrgPasswordFormControllerArgs } from "@/hooks/org-password-form-controller-args";
import type { OrgEntryFieldValues, OrgPasswordFormState } from "@/hooks/use-org-password-form-state";

type BuildOrgPasswordSubmitArgsInput = Pick<
  OrgPasswordFormControllerArgs,
  | "orgId"
  | "isEdit"
  | "editData"
  | "effectiveEntryType"
  | "translations"
  | "onSaved"
  | "handleOpenChange"
> & {
  cardNumberValid: boolean;
  isIdentity: boolean;
  values: OrgEntryFieldValues;
  setters: Pick<OrgPasswordFormState["setters"], "setDobError" | "setExpiryError" | "setSaving">;
};

export function buildOrgPasswordSubmitArgs({
  orgId,
  isEdit,
  editData,
  effectiveEntryType,
  cardNumberValid,
  isIdentity,
  translations,
  onSaved,
  handleOpenChange,
  values,
  setters,
}: BuildOrgPasswordSubmitArgsInput): SubmitOrgPasswordFormArgs {
  const { t, ti } = translations;
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
