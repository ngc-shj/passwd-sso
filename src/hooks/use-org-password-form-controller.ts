"use client";

import { toast } from "sonner";
import { submitOrgPasswordForm } from "@/components/team/team-password-form-actions";
import type { OrgPasswordFormProps } from "@/components/team/team-password-form-types";
import type { OrgEntryKindState } from "@/components/team/team-entry-kind";
import type { EntryTypeValue } from "@/lib/constants";
import type { OrgPasswordFormTranslations } from "@/hooks/entry-form-translations";
import {
  useOrgPasswordFormPresenter,
} from "@/hooks/use-org-password-form-presenter";
import { useOrgPasswordFormDerived } from "@/hooks/use-org-password-form-derived";
import { type OrgPasswordFormState } from "@/hooks/use-org-password-form-state";
import { buildOrgSubmitArgs } from "@/hooks/org-password-form-submit-args";
import { useTeamVault } from "@/lib/team-vault-context";

export interface OrgPasswordFormControllerArgs {
  orgId: OrgPasswordFormProps["orgId"];
  onSaved: OrgPasswordFormProps["onSaved"];
  isEdit: boolean;
  editData?: OrgPasswordFormProps["editData"];
  effectiveEntryType: EntryTypeValue;
  entryKindState: OrgEntryKindState;
  translations: OrgPasswordFormTranslations;
  formState: OrgPasswordFormState;
  handleOpenChange: (open: boolean) => void;
}

export interface TeamPasswordFormControllerArgs extends Omit<OrgPasswordFormControllerArgs, "orgId"> {
  teamId?: OrgPasswordFormProps["orgId"];
  orgId?: OrgPasswordFormProps["orgId"];
}

export function useOrgPasswordFormController({
  orgId,
  onSaved,
  isEdit,
  editData,
  effectiveEntryType,
  entryKindState,
  translations,
  formState,
  handleOpenChange,
}: OrgPasswordFormControllerArgs) {
  const { setters } = formState;
  const { getTeamKeyInfo } = useTeamVault();
  const { entryValues, cardNumberValid, entryCopy, entrySpecificFieldsProps } =
    useOrgPasswordFormPresenter({
    isEdit,
    entryKind: entryKindState.entryKind,
    translations,
    formState,
  });

  const { hasChanges, submitDisabled } = useOrgPasswordFormDerived({
    effectiveEntryType,
    editData,
    entryKindState,
    entryValues,
    cardNumberValid,
  });

  const handleSubmit = async () => {
    const keyInfo = await getTeamKeyInfo(orgId);
    if (!keyInfo) {
      toast.error(translations.t("failedToSave"));
      return;
    }

    const submitArgs = buildOrgSubmitArgs({
      orgId,
      orgEncryptionKey: keyInfo.key,
      orgKeyVersion: keyInfo.keyVersion,
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
    });
    await submitOrgPasswordForm(submitArgs);
  };

  return {
    entryCopy,
    entrySpecificFieldsProps,
    handleSubmit,
    hasChanges,
    submitDisabled,
  };
}

export function useTeamPasswordFormController({
  teamId,
  orgId,
  ...rest
}: TeamPasswordFormControllerArgs) {
  const scopedTeamId = teamId ?? orgId;
  if (!scopedTeamId) {
    throw new Error("useTeamPasswordFormController requires teamId or orgId");
  }
  return useOrgPasswordFormController({
    orgId: scopedTeamId,
    ...rest,
  });
}
