"use client";

import type { ComponentProps } from "react";
import { EntryActionBar } from "@/components/passwords/entry-form-ui";
import { EntryCustomFieldsTotpSection } from "@/components/passwords/entry-custom-fields-totp-section";
import { OrgTagsAndFolderSection } from "@/components/team/team-tags-and-folder-section";
import type { OrgFolderItem } from "@/components/team/team-password-form-types";
import type { OrgPasswordFormState } from "@/hooks/use-team-password-form-state";
import { buildEntryActionBarProps } from "@/hooks/entry-action-bar-props";

type OrgTagsAndFolderSectionProps = ComponentProps<typeof OrgTagsAndFolderSection>;
type EntryCustomFieldsTotpSectionProps = ComponentProps<typeof EntryCustomFieldsTotpSection>;
type EntryActionBarProps = ComponentProps<typeof EntryActionBar>;

interface UseOrgFormSectionsPropsArgs {
  orgId: string;
  tagsTitle: string;
  tagsHint: string;
  folders: OrgFolderItem[];
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
    OrgPasswordFormState["values"],
    "selectedTags" | "orgFolderId" | "customFields" | "totp" | "showTotpInput"
  >;
  setters: Pick<
    OrgPasswordFormState["setters"],
    "setSelectedTags" | "setOrgFolderId" | "setCustomFields" | "setTotp" | "setShowTotpInput"
  >;
}

interface OrgFormSectionsPropsResult {
  tagsAndFolderProps: OrgTagsAndFolderSectionProps;
  customFieldsTotpProps: EntryCustomFieldsTotpSectionProps | null;
  actionBarProps: EntryActionBarProps;
}

export function buildOrgFormSectionsProps({
  orgId,
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
}: UseOrgFormSectionsPropsArgs): OrgFormSectionsPropsResult {
  return {
    tagsAndFolderProps: {
      tagsTitle,
      tagsHint,
      orgId,
      selectedTags: values.selectedTags,
      onTagsChange: setters.setSelectedTags,
      folders,
      folderId: values.orgFolderId,
      onFolderChange: setters.setOrgFolderId,
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

export const buildTeamFormSectionsProps = buildOrgFormSectionsProps;
