"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import { buildGeneratorSummary } from "@/lib/generator-summary";
import {
  applyPolicyToGeneratorSettings,
  buildPolicyAwareGeneratorSettings,
} from "@/hooks/team-password-form-initial-values";
import { ENTRY_TYPE } from "@/lib/constants";
import { useTeamBaseFormModel } from "@/hooks/use-team-base-form-model";
import { buildTeamFormSectionsProps } from "@/hooks/team-form-sections-props";

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

  const tGen = base.translationBundle.tGen;

  // Entry-specific state (LOGIN)
  const [username, setUsername] = useState(editData?.username ?? "");
  const [password, setPassword] = useState(editData?.password ?? "");
  const [url, setUrl] = useState(editData?.url ?? "");
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [generatorSettings, setGeneratorSettings] = useState<GeneratorSettings>(
    () => buildPolicyAwareGeneratorSettings(base.teamPolicy),
  );
  const [customFields, setCustomFields] = useState<EntryCustomField[]>(
    editData?.customFields ?? [],
  );
  const [totp, setTotp] = useState<EntryTotp | null>(editData?.totp ?? null);
  const [showTotpInput, setShowTotpInput] = useState(Boolean(editData?.totp));

  useEffect(() => {
    setGeneratorSettings((current) =>
      applyPolicyToGeneratorSettings(current, base.teamPolicy),
    );
  }, [base.teamPolicy]);

  const generatorSummary = useMemo(
    () =>
      buildGeneratorSummary(generatorSettings, {
        modePassphrase: tGen("modePassphrase"),
        modePassword: tGen("modePassword"),
      }),
    [generatorSettings, tGen],
  );

  // hasChanges
  const baselineSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: editData?.title ?? "",
        notes: editData?.notes ?? "",
        username: editData?.username ?? "",
        password: editData?.password ?? "",
        url: editData?.url ?? "",
        customFields: JSON.stringify(editData?.customFields ?? []),
        totp: JSON.stringify(editData?.totp ?? null),
        selectedTagIds: (editData?.tags ?? defaultTags ?? [])
          .map((tag) => tag.id)
          .sort(),
        teamFolderId: editData?.teamFolderId ?? defaultFolderId ?? null,
        requireReprompt: editData?.requireReprompt ?? false,
        expiresAt: editData?.expiresAt ?? null,
      }),
    [editData, defaultFolderId, defaultTags],
  );

  const currentSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: base.title,
        notes: base.notes,
        username,
        password,
        url,
        customFields: JSON.stringify(customFields),
        totp: JSON.stringify(totp),
        selectedTagIds: base.selectedTags.map((tag) => tag.id).sort(),
        teamFolderId: base.teamFolderId,
        requireReprompt: base.requireReprompt,
        expiresAt: base.expiresAt,
      }),
    [
      base.title,
      base.notes,
      username,
      password,
      url,
      customFields,
      totp,
      base.selectedTags,
      base.teamFolderId,
      base.requireReprompt,
      base.expiresAt,
    ],
  );

  const hasChanges = currentSnapshot !== baselineSnapshot;
  const submitDisabled = !base.title.trim() || !password;

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
      customFields,
      totp,
      showTotpInput,
      requireReprompt: base.requireReprompt,
      expiresAt: base.expiresAt,
    },
    setters: {
      setSelectedTags: base.setSelectedTags,
      setTeamFolderId: base.setTeamFolderId,
      setCustomFields,
      setTotp,
      setShowTotpInput,
      setRequireReprompt: base.setRequireReprompt,
      setExpiresAt: base.setExpiresAt,
    },
  });

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitDisabled) return;

    const tagNames = base.selectedTags.map((tag) => ({
      name: tag.name,
      color: tag.color,
    }));

    await base.submitEntry({
      entryType: ENTRY_TYPE.LOGIN,
      title: base.title,
      notes: base.notes,
      tagNames,
      username,
      password,
      url,
      customFields,
      totp,
    });
  };

  return (
    <Dialog open={open} onOpenChange={base.handleOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{base.entryCopy.dialogLabel}</DialogTitle>
          <DialogDescription className="sr-only">
            {base.entryCopy.dialogLabel}
          </DialogDescription>
        </DialogHeader>

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

          <EntryLoginMainFields
            idPrefix="team-"
            hideTitle
            title={base.title}
            onTitleChange={base.setTitle}
            titleLabel={base.entryCopy.titleLabel}
            titlePlaceholder={base.entryCopy.titlePlaceholder}
            username={username}
            onUsernameChange={setUsername}
            usernameLabel={base.t("usernameEmail")}
            usernamePlaceholder={base.t("usernamePlaceholder")}
            password={password}
            onPasswordChange={setPassword}
            passwordLabel={base.t("password")}
            passwordPlaceholder={base.t("passwordPlaceholder")}
            showPassword={showPassword}
            onToggleShowPassword={() => setShowPassword(!showPassword)}
            generatorSummary={generatorSummary}
            showGenerator={showGenerator}
            onToggleGenerator={() => setShowGenerator(!showGenerator)}
            closeGeneratorLabel={base.t("closeGenerator")}
            openGeneratorLabel={base.t("openGenerator")}
            generatorSettings={generatorSettings}
            onGeneratorUse={(pw, settings) => {
              setPassword(pw);
              setGeneratorSettings(settings);
            }}
            url={url}
            onUrlChange={setUrl}
            urlLabel={base.t("url")}
            notes={base.notes}
            onNotesChange={base.setNotes}
            notesLabel={base.entryCopy.notesLabel}
            notesPlaceholder={base.entryCopy.notesPlaceholder}
            teamPolicy={base.teamPolicy}
          />

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
      </DialogContent>
    </Dialog>
  );
}
