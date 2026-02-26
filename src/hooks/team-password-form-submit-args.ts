"use client";

import type { SubmitTeamPasswordFormArgs } from "@/components/team/team-password-form-actions";
import type { TeamPasswordFormProps } from "@/components/team/team-password-form-types";
import type { TeamEntryKindState } from "@/components/team/team-entry-kind";
import type { EntryTypeValue } from "@/lib/constants";
import type { TeamPasswordFormTranslations } from "@/hooks/entry-form-translations";
import type { TeamPasswordFormState } from "@/hooks/use-team-password-form-state";
import type { useTeamPasswordFormPresenter } from "@/hooks/use-team-password-form-presenter";

type OrgEntryValues = ReturnType<typeof useTeamPasswordFormPresenter>["entryValues"];

interface BuildOrgSubmitArgsParams {
  orgId: TeamPasswordFormProps["orgId"];
  orgEncryptionKey: CryptoKey;
  orgKeyVersion: number;
  onSaved: TeamPasswordFormProps["onSaved"];
  isEdit: boolean;
  editData?: TeamPasswordFormProps["editData"];
  effectiveEntryType: EntryTypeValue;
  entryKindState: TeamEntryKindState;
  translations: TeamPasswordFormTranslations;
  handleOpenChange: (open: boolean) => void;
  setters: Pick<TeamPasswordFormState["setters"], "setDobError" | "setExpiryError" | "setSaving">;
  entryValues: OrgEntryValues;
  cardNumberValid: boolean;
}

export function buildTeamSubmitArgs({
  orgId,
  orgEncryptionKey,
  orgKeyVersion,
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
}: BuildOrgSubmitArgsParams): SubmitTeamPasswordFormArgs {
  return {
    orgId,
    orgEncryptionKey,
    orgKeyVersion,
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
