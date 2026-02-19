"use client";

import type { SubmitOrgPasswordFormArgs } from "@/components/org/org-password-form-actions";
import type { OrgPasswordFormProps } from "@/components/org/org-password-form-types";
import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import type { EntryTypeValue } from "@/lib/constants";
import type { OrgPasswordFormTranslations } from "@/hooks/entry-form-translations";
import type { OrgPasswordFormState } from "@/hooks/use-org-password-form-state";
import type { useOrgPasswordFormPresenter } from "@/hooks/use-org-password-form-presenter";

type OrgEntryValues = ReturnType<typeof useOrgPasswordFormPresenter>["entryValues"];

interface BuildOrgSubmitArgsParams {
  orgId: OrgPasswordFormProps["orgId"];
  onSaved: OrgPasswordFormProps["onSaved"];
  isEdit: boolean;
  editData?: OrgPasswordFormProps["editData"];
  effectiveEntryType: EntryTypeValue;
  entryKindState: OrgEntryKindState;
  translations: OrgPasswordFormTranslations;
  handleOpenChange: (open: boolean) => void;
  setters: Pick<OrgPasswordFormState["setters"], "setDobError" | "setExpiryError" | "setSaving">;
  entryValues: OrgEntryValues;
  cardNumberValid: boolean;
}

export function buildOrgSubmitArgs({
  orgId,
  onSaved,
  isEdit,
  editData,
  effectiveEntryType,
  entryKindState,
  translations,
  handleOpenChange,
  setters,
  entryValues,
  cardNumberValid,
}: BuildOrgSubmitArgsParams): SubmitOrgPasswordFormArgs {
  return {
    orgId,
    isEdit,
    editData,
    effectiveEntryType,
    ...entryValues,
    cardNumberValid,
    isIdentity: entryKindState.isIdentity,
    setDobError: setters.setDobError,
    setExpiryError: setters.setExpiryError,
    identityErrorCopy: {
      dobFuture: translations.ti("dobFuture"),
      expiryBeforeIssue: translations.ti("expiryBeforeIssue"),
    },
    t: translations.t,
    setSaving: setters.setSaving,
    handleOpenChange,
    onSaved,
  };
}
