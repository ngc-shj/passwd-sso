"use client";

import type { ComponentProps } from "react";
import { EntryActionBar } from "@/components/passwords/entry-form-ui";
import { EntryCustomFieldsTotpSection } from "@/components/passwords/entry-custom-fields-totp-section";
import { EntryRepromptSection } from "@/components/passwords/entry-reprompt-section";
import { EntryExpirationSection } from "@/components/passwords/entry-expiration-section";
import { EntryTagsAndFolderSection } from "@/components/passwords/entry-tags-and-folder-section";
import type { PersonalPasswordFormState } from "@/hooks/use-personal-password-form-state";
import { buildEntryActionBarProps } from "@/hooks/entry-action-bar-props";

type EntryTagsAndFolderSectionProps = ComponentProps<typeof EntryTagsAndFolderSection>;
type EntryCustomFieldsTotpSectionProps = ComponentProps<typeof EntryCustomFieldsTotpSection>;
type EntryRepromptSectionProps = ComponentProps<typeof EntryRepromptSection>;
type EntryExpirationSectionProps = ComponentProps<typeof EntryExpirationSection>;
type EntryActionBarProps = ComponentProps<typeof EntryActionBar>;

interface UsePersonalFormSectionsPropsArgs {
  tagsTitle: string;
  tagsHint: string;
  folders: EntryTagsAndFolderSectionProps["folders"];
  sectionCardClass: string;
  repromptTitle: string;
  repromptDescription: string;
  expirationTitle: string;
  expirationDescription: string;
  hasChanges: boolean;
  submitting: boolean;
  saveLabel: string;
  cancelLabel: string;
  statusUnsavedLabel: string;
  statusSavedLabel: string;
  onCancel: () => void;
  values: Pick<
    PersonalPasswordFormState["values"],
    "selectedTags" | "folderId" | "customFields" | "totp" | "showTotpInput" | "requireReprompt" | "expiresAt"
  >;
  setters: Pick<
    PersonalPasswordFormState["setters"],
    | "setSelectedTags"
    | "setFolderId"
    | "setCustomFields"
    | "setTotp"
    | "setShowTotpInput"
    | "setRequireReprompt"
    | "setExpiresAt"
  >;
}

interface PersonalFormSectionsPropsResult {
  tagsAndFolderProps: EntryTagsAndFolderSectionProps;
  customFieldsTotpProps: EntryCustomFieldsTotpSectionProps;
  repromptSectionProps: EntryRepromptSectionProps;
  expirationSectionProps: EntryExpirationSectionProps;
  actionBarProps: EntryActionBarProps;
}

export function buildPersonalFormSectionsProps({
  tagsTitle,
  tagsHint,
  folders,
  sectionCardClass,
  repromptTitle,
  repromptDescription,
  expirationTitle,
  expirationDescription,
  hasChanges,
  submitting,
  saveLabel,
  cancelLabel,
  statusUnsavedLabel,
  statusSavedLabel,
  onCancel,
  values,
  setters,
}: UsePersonalFormSectionsPropsArgs): PersonalFormSectionsPropsResult {
  return {
    tagsAndFolderProps: {
      tagsTitle,
      tagsHint,
      selectedTags: values.selectedTags,
      onTagsChange: setters.setSelectedTags,
      folders,
      folderId: values.folderId,
      onFolderChange: setters.setFolderId,
      sectionCardClass,
    },
    customFieldsTotpProps: {
      customFields: values.customFields,
      setCustomFields: setters.setCustomFields,
      totp: values.totp,
      onTotpChange: setters.setTotp,
      showTotpInput: values.showTotpInput,
      setShowTotpInput: setters.setShowTotpInput,
      sectionCardClass,
    },
    repromptSectionProps: {
      checked: values.requireReprompt,
      onCheckedChange: setters.setRequireReprompt,
      title: repromptTitle,
      description: repromptDescription,
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
      submitting,
      saveLabel,
      cancelLabel,
      statusUnsavedLabel,
      statusSavedLabel,
      onCancel,
    }),
  };
}
