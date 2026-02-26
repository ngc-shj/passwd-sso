"use client";

import { toast } from "sonner";
import { submitTeamPasswordForm } from "@/components/team/team-password-form-actions";
import type { TeamPasswordFormProps } from "@/components/team/team-password-form-types";
import type { TeamEntryKindState } from "@/components/team/team-entry-kind";
import type { EntryTypeValue } from "@/lib/constants";
import type { TeamPasswordFormTranslations } from "@/hooks/entry-form-translations";
import {
  useTeamPasswordFormPresenter,
} from "@/hooks/use-team-password-form-presenter";
import { useTeamPasswordFormDerived } from "@/hooks/use-team-password-form-derived";
import { type TeamPasswordFormState } from "@/hooks/use-team-password-form-state";
import { buildTeamSubmitArgs } from "@/hooks/team-password-form-submit-args";
import { useTeamVault } from "@/lib/team-vault-context";

export interface TeamPasswordFormControllerArgs {
  orgId: TeamPasswordFormProps["orgId"];
  onSaved: TeamPasswordFormProps["onSaved"];
  isEdit: boolean;
  editData?: TeamPasswordFormProps["editData"];
  effectiveEntryType: EntryTypeValue;
  entryKindState: TeamEntryKindState;
  translations: TeamPasswordFormTranslations;
  formState: TeamPasswordFormState;
  handleOpenChange: (open: boolean) => void;
}

export interface TeamPasswordFormControllerCompatArgs extends Omit<TeamPasswordFormControllerArgs, "orgId"> {
  teamId?: TeamPasswordFormProps["orgId"];
  orgId?: TeamPasswordFormProps["orgId"];
}

function useTeamPasswordFormControllerInternal({
  orgId,
  onSaved,
  isEdit,
  editData,
  effectiveEntryType,
  entryKindState,
  translations,
  formState,
  handleOpenChange,
}: TeamPasswordFormControllerArgs) {
  const { setters } = formState;
  const { getTeamKeyInfo } = useTeamVault();
  const { entryValues, cardNumberValid, entryCopy, entrySpecificFieldsProps } =
    useTeamPasswordFormPresenter({
    isEdit,
    entryKind: entryKindState.entryKind,
    translations,
    formState,
  });

  const { hasChanges, submitDisabled } = useTeamPasswordFormDerived({
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

    const submitArgs = buildTeamSubmitArgs({
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
    await submitTeamPasswordForm(submitArgs);
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
}: TeamPasswordFormControllerCompatArgs) {
  const scopedTeamId = teamId ?? orgId;
  if (!scopedTeamId) {
    throw new Error("useTeamPasswordFormController requires teamId or orgId");
  }
  return useTeamPasswordFormControllerInternal({
    orgId: scopedTeamId,
    ...rest,
  });
}
