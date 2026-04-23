"use client";

import type { ComponentProps, Dispatch, SetStateAction } from "react";
import { EntryActionBar } from "@/components/passwords/entry-form-ui";
import { EntryCustomFieldsTotpSection } from "@/components/passwords/entry-custom-fields-totp-section";
import { EntryRepromptSection } from "@/components/passwords/entry-reprompt-section";
import { EntryTravelSafeSection } from "@/components/passwords/entry-travel-safe-section";
import { EntryExpirationSection } from "@/components/passwords/entry-expiration-section";
import { TeamTagsAndFolderSection } from "@/components/team/team-tags-and-folder-section";
import type { TeamFolderItem } from "@/components/team/team-entry-form-types";
import type { TeamTagData } from "@/components/team/team-tag-input";
import type { EntryCustomField, EntryTotp } from "@/lib/vault/entry-form-types";
import { buildEntryActionBarProps } from "@/hooks/form/entry-action-bar-props";

type TeamTagsAndFolderSectionProps = ComponentProps<typeof TeamTagsAndFolderSection>;
type EntryCustomFieldsTotpSectionProps = ComponentProps<typeof EntryCustomFieldsTotpSection>;
type EntryActionBarProps = ComponentProps<typeof EntryActionBar>;
type EntryRepromptSectionProps = ComponentProps<typeof EntryRepromptSection>;
type EntryTravelSafeSectionProps = ComponentProps<typeof EntryTravelSafeSection>;
type EntryExpirationSectionProps = ComponentProps<typeof EntryExpirationSection>;

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
  repromptTitle: string;
  repromptDescription: string;
  repromptPolicyForced?: boolean;
  repromptPolicyForcedLabel?: string;
  travelSafeTitle: string;
  travelSafeDescription: string;
  expirationTitle: string;
  expirationDescription: string;
  onCancel: () => void;
  values: {
    selectedTags: TeamTagData[];
    teamFolderId: string | null;
    customFields: EntryCustomField[];
    totp: EntryTotp | null;
    showTotpInput: boolean;
    requireReprompt: boolean;
    travelSafe: boolean;
    expiresAt: string | null;
  };
  setters: {
    setSelectedTags: Dispatch<SetStateAction<TeamTagData[]>>;
    setTeamFolderId: Dispatch<SetStateAction<string | null>>;
    setCustomFields: Dispatch<SetStateAction<EntryCustomField[]>>;
    setTotp: Dispatch<SetStateAction<EntryTotp | null>>;
    setShowTotpInput: Dispatch<SetStateAction<boolean>>;
    setRequireReprompt: Dispatch<SetStateAction<boolean>>;
    setTravelSafe: Dispatch<SetStateAction<boolean>>;
    setExpiresAt: Dispatch<SetStateAction<string | null>>;
  };
}

interface TeamFormSectionsPropsResult {
  tagsAndFolderProps: TeamTagsAndFolderSectionProps;
  customFieldsTotpProps: EntryCustomFieldsTotpSectionProps | null;
  repromptSectionProps: EntryRepromptSectionProps;
  travelSafeSectionProps: EntryTravelSafeSectionProps;
  expirationSectionProps: EntryExpirationSectionProps;
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
  repromptTitle,
  repromptDescription,
  repromptPolicyForced,
  repromptPolicyForcedLabel,
  travelSafeTitle,
  travelSafeDescription,
  expirationTitle,
  expirationDescription,
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
    repromptSectionProps: {
      checked: values.requireReprompt,
      onCheckedChange: setters.setRequireReprompt,
      title: repromptTitle,
      description: repromptDescription,
      sectionCardClass,
      policyForced: repromptPolicyForced,
      policyForcedLabel: repromptPolicyForcedLabel,
    },
    travelSafeSectionProps: {
      checked: values.travelSafe,
      onCheckedChange: setters.setTravelSafe,
      title: travelSafeTitle,
      description: travelSafeDescription,
      sectionCardClass,
    },
    expirationSectionProps: {
      value: values.expiresAt,
      onChange: setters.setExpiresAt,
      title: expirationTitle,
      description: expirationDescription,
      sectionCardClass,
    },
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
