"use client";

import { ENTRY_TYPE } from "@/lib/constants";
import { getTeamEntryKindState } from "@/components/team/team-entry-kind";
import type { TeamPasswordFormProps } from "@/components/team/team-password-form-types";
import { useTeamAttachments } from "@/hooks/use-team-attachments";
import { useTeamFolders } from "@/hooks/use-team-folders";
import { useTeamPasswordFormController } from "@/hooks/use-team-password-form-controller";
import { useTeamPasswordFormLifecycle } from "@/hooks/use-team-password-form-lifecycle";
import {
  toTeamPasswordFormTranslations,
  useEntryFormTranslations,
} from "@/hooks/use-entry-form-translations";
import {
  type TeamPasswordFormLifecycleSetters,
  useTeamPasswordFormState,
} from "@/hooks/use-team-password-form-state";

type TeamPasswordFormModelBaseInput = Pick<
  TeamPasswordFormProps,
  "teamId" | "open" | "onOpenChange" | "onSaved" | "entryType" | "editData"
>;

function useTeamPasswordFormModelInternal({
  teamId,
  open,
  onOpenChange,
  onSaved,
  entryType: entryTypeProp = ENTRY_TYPE.LOGIN,
  editData,
}: TeamPasswordFormModelBaseInput) {
  const translationBundle = useEntryFormTranslations();
  const { t, tc } = translationBundle;
  const translations = toTeamPasswordFormTranslations(translationBundle);

  const effectiveEntryType = editData?.entryType ?? entryTypeProp;
  const entryKindState = getTeamEntryKindState(effectiveEntryType);
  const { isLoginEntry } = entryKindState;
  const isEdit = !!editData;

  const formState = useTeamPasswordFormState(editData);

  const { attachments, setAttachments } = useTeamAttachments(open, teamId, editData?.id);
  const { folders: teamFolders } = useTeamFolders(open, teamId);

  const formSetters: TeamPasswordFormLifecycleSetters = { ...formState.setters, setAttachments };
  const { handleOpenChange } = useTeamPasswordFormLifecycle({
    open,
    editData,
    onOpenChange,
    setters: formSetters,
  });

  const { entryCopy, entrySpecificFieldsProps, handleSubmit, hasChanges, submitDisabled } =
    useTeamPasswordFormController({
      teamId,
      onSaved,
      isEdit,
      editData,
      effectiveEntryType,
      entryKindState,
      translations,
      formState,
      handleOpenChange,
    });

  return {
    t,
    tc,
    isEdit,
    isLoginEntry,
    editData,
    formState,
    attachments,
    setAttachments,
    teamFolders,
    handleOpenChange,
    entryCopy,
    entrySpecificFieldsProps,
    handleSubmit,
    hasChanges,
    submitDisabled,
  };
}

export function useTeamPasswordFormModel(input: TeamPasswordFormModelBaseInput) {
  return useTeamPasswordFormModelInternal(input);
}
