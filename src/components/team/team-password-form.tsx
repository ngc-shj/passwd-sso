"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EntryLoginMainFields } from "@/components/passwords/entry-login-main-fields";
import { EntryCustomFieldsTotpSection } from "@/components/passwords/entry-custom-fields-totp-section";
import { EntryRepromptSection } from "@/components/passwords/entry-reprompt-section";
import { EntryExpirationSection } from "@/components/passwords/entry-expiration-section";
import { TeamAttachmentSection } from "./team-attachment-section";
import { TeamTagsAndFolderSection } from "@/components/team/team-tags-and-folder-section";
import type { TeamPasswordFormProps } from "@/components/team/team-password-form-types";
import { preventIMESubmit } from "@/lib/ime-guard";
import {
  EntryActionBar,
  ENTRY_DIALOG_FLAT_SECTION_CLASS,
} from "@/components/passwords/entry-form-ui";
import { useTeamBaseFormModel } from "@/hooks/use-team-base-form-model";
import { buildTeamFormSectionsProps } from "@/hooks/team-form-sections-props";
import { useTeamLoginFormState } from "@/hooks/use-team-login-form-state";
import { buildTeamLoginFormDerived } from "@/hooks/team-login-form-derived";
import { buildTeamLoginFieldsProps } from "@/hooks/team-login-fields-props";
import { createTeamLoginSubmitHandler } from "@/hooks/team-login-form-controller";

export function TeamPasswordForm({
  teamId,
  open,
  onOpenChange,
  onSaved,
  entryType,
  editData,
  defaultFolderId,
  defaultTags,
}: TeamPasswordFormProps) {
  const base = useTeamBaseFormModel({
    teamId,
    open,
    onOpenChange,
    onSaved,
    entryType,
    editData,
    defaultFolderId,
    defaultTags,
  });
  const loginState = useTeamLoginFormState({
    editData,
    teamPolicy: base.teamPolicy,
  });
  const { hasChanges, generatorSummary } = buildTeamLoginFormDerived({
    editData,
    defaultFolderId,
    defaultTags,
    title: base.title,
    notes: base.notes,
    username: loginState.username,
    password: loginState.password,
    url: loginState.url,
    customFields: loginState.customFields,
    totp: loginState.totp,
    selectedTags: base.selectedTags,
    teamFolderId: base.teamFolderId,
    requireReprompt: base.requireReprompt,
    expiresAt: base.expiresAt,
    generatorSettings: loginState.generatorSettings,
    tGen: base.translationBundle.tGen,
  });
  const submitDisabled = !base.title.trim() || !loginState.password;

  const dialogSectionClass = ENTRY_DIALOG_FLAT_SECTION_CLASS;

  const {
    tagsAndFolderProps,
    customFieldsTotpProps,
    repromptSectionProps,
    expirationSectionProps,
    actionBarProps,
  } = buildTeamFormSectionsProps({
    teamId,
    tagsTitle: base.entryCopy.tagsTitle,
    tagsHint: base.t("tagsHint"),
    folders: base.teamFolders,
    sectionCardClass: dialogSectionClass,
    isLoginEntry: true,
    hasChanges,
    saving: base.saving,
    submitDisabled,
    saveLabel: base.isEdit ? base.tc("update") : base.tc("save"),
    cancelLabel: base.tc("cancel"),
    statusUnsavedLabel: base.t("statusUnsaved"),
    statusSavedLabel: base.t("statusSaved"),
    repromptTitle: base.t("requireReprompt"),
    repromptDescription: base.t("requireRepromptHelp"),
    repromptPolicyForced: base.teamPolicy?.requireRepromptForAll,
    repromptPolicyForcedLabel: base.teamPolicy?.requireRepromptForAll
      ? base.t("requireRepromptPolicyForced")
      : undefined,
    expirationTitle: base.t("expirationTitle"),
    expirationDescription: base.t("expirationDescription"),
    onCancel: () => base.handleOpenChange(false),
    values: {
      selectedTags: base.selectedTags,
      teamFolderId: base.teamFolderId,
      customFields: loginState.customFields,
      totp: loginState.totp,
      showTotpInput: loginState.showTotpInput,
      requireReprompt: base.requireReprompt,
      expiresAt: base.expiresAt,
    },
    setters: {
      setSelectedTags: base.setSelectedTags,
      setTeamFolderId: base.setTeamFolderId,
      setCustomFields: loginState.setCustomFields,
      setTotp: loginState.setTotp,
      setShowTotpInput: loginState.setShowTotpInput,
      setRequireReprompt: base.setRequireReprompt,
      setExpiresAt: base.setExpiresAt,
    },
  });

  const loginMainFieldsProps = buildTeamLoginFieldsProps({
    title: base.title,
    onTitleChange: base.setTitle,
    titleLabel: base.entryCopy.titleLabel,
    titlePlaceholder: base.entryCopy.titlePlaceholder,
    username: loginState.username,
    onUsernameChange: loginState.setUsername,
    usernameLabel: base.t("usernameEmail"),
    usernamePlaceholder: base.t("usernamePlaceholder"),
    password: loginState.password,
    onPasswordChange: loginState.setPassword,
    passwordLabel: base.t("password"),
    passwordPlaceholder: base.t("passwordPlaceholder"),
    showPassword: loginState.showPassword,
    onToggleShowPassword: () => loginState.setShowPassword(!loginState.showPassword),
    generatorSummary,
    showGenerator: loginState.showGenerator,
    onToggleGenerator: () => loginState.setShowGenerator(!loginState.showGenerator),
    closeGeneratorLabel: base.t("closeGenerator"),
    openGeneratorLabel: base.t("openGenerator"),
    generatorSettings: loginState.generatorSettings,
    onGeneratorUse: (pw, settings) => {
      loginState.setPassword(pw);
      loginState.setGeneratorSettings(settings);
    },
    url: loginState.url,
    onUrlChange: loginState.setUrl,
    urlLabel: base.t("url"),
    notes: base.notes,
    onNotesChange: base.setNotes,
    notesLabel: base.entryCopy.notesLabel,
    notesPlaceholder: base.entryCopy.notesPlaceholder,
    teamPolicy: base.teamPolicy,
  });
  const handleFormSubmit = createTeamLoginSubmitHandler({
    submitDisabled,
    submitEntry: base.submitEntry,
    title: base.title,
    notes: base.notes,
    selectedTags: base.selectedTags,
    username: loginState.username,
    password: loginState.password,
    url: loginState.url,
    customFields: loginState.customFields,
    totp: loginState.totp,
  });

  return (
    <>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleFormSubmit(e);
          }}
          onKeyDown={preventIMESubmit}
          className="space-y-5"
        >
          <div className="space-y-2">
            <Label>{base.entryCopy.titleLabel}</Label>
            <Input
              value={base.title}
              onChange={(e) => base.setTitle(e.target.value)}
              placeholder={base.entryCopy.titlePlaceholder}
            />
          </div>

          <EntryLoginMainFields {...loginMainFieldsProps} />

          <TeamTagsAndFolderSection {...tagsAndFolderProps} />

          {customFieldsTotpProps && (
            <EntryCustomFieldsTotpSection {...customFieldsTotpProps} />
          )}

          <EntryRepromptSection {...repromptSectionProps} />
          <EntryExpirationSection {...expirationSectionProps} />
          <EntryActionBar {...actionBarProps} />
        </form>

        {base.isEdit && editData && (
          <div className="border-t pt-4">
            <TeamAttachmentSection
              teamId={teamId}
              entryId={editData.id}
              attachments={base.attachments}
              onAttachmentsChange={base.setAttachments}
            />
          </div>
        )}
    </>
  );
}
