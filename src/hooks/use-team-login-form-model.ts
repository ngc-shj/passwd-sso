"use client";

import type { TeamEntryFormProps } from "@/components/team/team-entry-form-types";
import { ENTRY_DIALOG_FLAT_SECTION_CLASS } from "@/components/passwords/entry-form-ui";
import { buildTeamFormSectionsProps } from "@/hooks/team-form-sections-props";
import { createTeamLoginSubmitHandler } from "@/hooks/team-login-form-controller";
import { buildTeamLoginFormPresenter } from "@/hooks/team-login-form-presenter";
import { useTeamBaseFormModel } from "@/hooks/use-team-base-form-model";
import { useTeamLoginFormState } from "@/hooks/use-team-login-form-state";

type TeamLoginFormModelInput = Pick<
  TeamEntryFormProps,
  "teamId" | "open" | "onOpenChange" | "onSaved" | "entryType" | "editData" | "defaultFolderId" | "defaultTags"
>;

export function useTeamLoginFormModel({
  teamId,
  open,
  onOpenChange,
  onSaved,
  entryType,
  editData,
  defaultFolderId,
  defaultTags,
}: TeamLoginFormModelInput) {
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
  const { hasChanges, loginMainFieldsProps } = buildTeamLoginFormPresenter({
    editData,
    defaultFolderId,
    defaultTags,
    title: base.title,
    setTitle: base.setTitle,
    notes: base.notes,
    setNotes: base.setNotes,
    username: loginState.username,
    setUsername: loginState.setUsername,
    password: loginState.password,
    setPassword: loginState.setPassword,
    url: loginState.url,
    setUrl: loginState.setUrl,
    customFields: loginState.customFields,
    totp: loginState.totp,
    selectedTags: base.selectedTags,
    teamFolderId: base.teamFolderId,
    requireReprompt: base.requireReprompt,
    expiresAt: base.expiresAt,
    generatorSettings: loginState.generatorSettings,
    setGeneratorSettings: loginState.setGeneratorSettings,
    showPassword: loginState.showPassword,
    setShowPassword: loginState.setShowPassword,
    showGenerator: loginState.showGenerator,
    setShowGenerator: loginState.setShowGenerator,
    titleLabel: base.entryCopy.titleLabel,
    titlePlaceholder: base.entryCopy.titlePlaceholder,
    notesLabel: base.entryCopy.notesLabel,
    notesPlaceholder: base.entryCopy.notesPlaceholder,
    teamPolicy: base.teamPolicy,
    t: base.t,
    tGen: base.translationBundle.tGen,
  });
  const submitDisabled = !base.title.trim() || !loginState.password;

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
    sectionCardClass: ENTRY_DIALOG_FLAT_SECTION_CLASS,
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

  return {
    base,
    editData,
    teamId,
    loginState,
    loginMainFieldsProps,
    customFieldsTotpProps,
    tagsAndFolderProps,
    repromptSectionProps,
    expirationSectionProps,
    actionBarProps,
    handleFormSubmit,
  };
}
