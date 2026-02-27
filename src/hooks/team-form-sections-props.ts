"use client";

import type { ComponentProps } from "react";
import { EntryActionBar } from "@/components/passwords/entry-form-ui";
import { EntryCustomFieldsTotpSection } from "@/components/passwords/entry-custom-fields-totp-section";
import { TeamTagsAndFolderSection } from "@/components/team/team-tags-and-folder-section";
import type { TeamFolderItem } from "@/components/team/team-password-form-types";
import type { TeamPasswordFormState } from "@/hooks/use-team-password-form-state";
import { buildEntryActionBarProps } from "@/hooks/entry-action-bar-props";

type TeamTagsAndFolderSectionProps = ComponentProps<typeof TeamTagsAndFolderSection>;
type EntryCustomFieldsTotpSectionProps = ComponentProps<typeof EntryCustomFieldsTotpSection>;
type EntryActionBarProps = ComponentProps<typeof EntryActionBar>;

interface UseTeamFormSectionsPropsArgs {
  teamId?: string;
  tagsTitle: string;
  tagsHint: string;
  folders: TeamFolderItem[];
  sectionCardClass: string;
  isLoginEntry: boolean;
  hasChanges: boolean;
  saving: boolean;
  submitDisabled: boolean;
  saveLabel: string;
  cancelLabel: string;
  statusUnsavedLabel: string;
  statusSavedLabel: string;
  onCancel: () => void;
  values: Pick<
    TeamPasswordFormState["values"],
    "selectedTags" | "teamFolderId" | "customFields" | "totp" | "showTotpInput"
  >;
  setters: Pick<
    TeamPasswordFormState["setters"],
    "setSelectedTags" | "setTeamFolderId" | "setCustomFields" | "setTotp" | "setShowTotpInput"
  >;
}

interface TeamFormSectionsPropsResult {
  tagsAndFolderProps: TeamTagsAndFolderSectionProps;
  customFieldsTotpProps: EntryCustomFieldsTotpSectionProps | null;
  actionBarProps: EntryActionBarProps;
}

export function buildTeamFormSectionsProps({
  teamId,
  tagsTitle,
  tagsHint,
  folders,
  sectionCardClass,
  isLoginEntry,
  hasChanges,
  saving,
  submitDisabled,
  saveLabel,
  cancelLabel,
  statusUnsavedLabel,
  statusSavedLabel,
  onCancel,
  values,
  setters,
}: UseTeamFormSectionsPropsArgs): TeamFormSectionsPropsResult {
  const scopedTeamId = teamId ?? "";
  return {
    tagsAndFolderProps: {
      tagsTitle,
      tagsHint,
      teamId: scopedTeamId,
      selectedTags: values.selectedTags,
      onTagsChange: setters.setSelectedTags,
      folders,
      folderId: values.teamFolderId,
      onFolderChange: setters.setTeamFolderId,
      sectionCardClass,
    },
    customFieldsTotpProps: isLoginEntry
      ? {
          customFields: values.customFields,
          setCustomFields: setters.setCustomFields,
          totp: values.totp,
          onTotpChange: setters.setTotp,
          showTotpInput: values.showTotpInput,
          setShowTotpInput: setters.setShowTotpInput,
          sectionCardClass,
        }
      : null,
    actionBarProps: buildEntryActionBarProps({
      hasChanges,
      submitting: saving,
      submitDisabled,
      saveLabel,
      cancelLabel,
      statusUnsavedLabel,
      statusSavedLabel,
      onCancel,
    }),
  };
}
