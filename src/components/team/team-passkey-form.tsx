"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasskeyFields } from "@/components/entry-fields/passkey-fields";
import { TeamTagsAndFolderSection } from "@/components/team/team-tags-and-folder-section";
import { EntryRepromptSection } from "@/components/passwords/entry-reprompt-section";
import { EntryTravelSafeSection } from "@/components/passwords/entry-travel-safe-section";
import { EntryExpirationSection } from "@/components/passwords/entry-expiration-section";
import { TeamAttachmentSection } from "./team-attachment-section";
import {
  EntryActionBar,
  ENTRY_DIALOG_FLAT_SECTION_CLASS,
} from "@/components/passwords/entry-form-ui";
import type { TeamEntryFormProps } from "@/components/team/team-entry-form-types";
import { preventIMESubmit } from "@/lib/ime-guard";
import { ENTRY_TYPE } from "@/lib/constants";
import { useTeamBaseFormModel } from "@/hooks/team/use-team-base-form-model";
import { buildTeamFormSectionsProps } from "@/hooks/team/team-form-sections-props";
import { useEntryHasChanges } from "@/hooks/use-entry-has-changes";

export function TeamPasskeyForm({
  teamId,
  open,
  onOpenChange,
  onSaved,
  entryType,
  editData,
  defaultFolderId,
  defaultTags,
}: TeamEntryFormProps) {
  const tpk = useTranslations("PasskeyForm");
  const ttm = useTranslations("TravelMode");
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

  // Entry-specific state
  const [relyingPartyId, setRelyingPartyId] = useState(editData?.relyingPartyId ?? "");
  const [relyingPartyName, setRelyingPartyName] = useState(editData?.relyingPartyName ?? "");
  const [username, setUsername] = useState(editData?.username ?? "");
  const [credentialId, setCredentialId] = useState(editData?.credentialId ?? "");
  const [showCredentialId, setShowCredentialId] = useState(false);
  const [creationDate, setCreationDate] = useState(editData?.creationDate ?? "");
  const [deviceInfo, setDeviceInfo] = useState(editData?.deviceInfo ?? "");

  const hasChanges = useEntryHasChanges(
    () => ({
      title: base.title,
      notes: base.notes,
      relyingPartyId,
      relyingPartyName,
      username,
      credentialId,
      creationDate,
      deviceInfo,
      selectedTagIds: base.selectedTags.map((tag) => tag.id).sort(),
      teamFolderId: base.teamFolderId,
      requireReprompt: base.requireReprompt,
      travelSafe: base.travelSafe,
      expiresAt: base.expiresAt,
    }),
    [
      base.title,
      base.notes,
      relyingPartyId,
      relyingPartyName,
      username,
      credentialId,
      creationDate,
      deviceInfo,
      base.selectedTags,
      base.teamFolderId,
      base.requireReprompt,
      base.travelSafe,
      base.expiresAt,
    ],
  );
  const submitDisabled = !base.title.trim() || !relyingPartyId.trim();

  const dialogSectionClass = ENTRY_DIALOG_FLAT_SECTION_CLASS;

  const {
    tagsAndFolderProps,
    repromptSectionProps,
    travelSafeSectionProps,
    expirationSectionProps,
    actionBarProps,
  } = buildTeamFormSectionsProps({
    teamId,
    tagsTitle: base.entryCopy.tagsTitle,
    tagsHint: base.t("tagsHint"),
    folders: base.teamFolders,
    sectionCardClass: dialogSectionClass,
    isLoginEntry: false,
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
    travelSafeTitle: ttm("travelSafe"),
    travelSafeDescription: ttm("travelSafeDescription"),
    expirationTitle: base.t("expirationTitle"),
    expirationDescription: base.t("expirationDescription"),
    onCancel: () => base.handleOpenChange(false),
    values: {
      selectedTags: base.selectedTags,
      teamFolderId: base.teamFolderId,
      customFields: [],
      totp: null,
      showTotpInput: false,
      requireReprompt: base.requireReprompt,
      travelSafe: base.travelSafe,
      expiresAt: base.expiresAt,
    },
    setters: {
      setSelectedTags: base.setSelectedTags,
      setTeamFolderId: base.setTeamFolderId,
      setCustomFields: () => {},
      setTotp: () => {},
      setShowTotpInput: () => {},
      setRequireReprompt: base.setRequireReprompt,
      setTravelSafe: base.setTravelSafe,
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
      entryType: ENTRY_TYPE.PASSKEY,
      title: base.title,
      notes: base.notes,
      tagNames,
      relyingPartyId,
      relyingPartyName,
      username,
      credentialId,
      creationDate,
      deviceInfo,
    });
  };

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

          <PasskeyFields
            idPrefix="team-"
            relyingPartyId={relyingPartyId}
            onRelyingPartyIdChange={setRelyingPartyId}
            relyingPartyIdPlaceholder={tpk("relyingPartyIdPlaceholder")}
            relyingPartyName={relyingPartyName}
            onRelyingPartyNameChange={setRelyingPartyName}
            relyingPartyNamePlaceholder={tpk("relyingPartyNamePlaceholder")}
            username={username}
            onUsernameChange={setUsername}
            usernamePlaceholder={tpk("usernamePlaceholder")}
            credentialId={credentialId}
            onCredentialIdChange={setCredentialId}
            credentialIdPlaceholder={tpk("credentialIdPlaceholder")}
            showCredentialId={showCredentialId}
            onToggleCredentialId={() => setShowCredentialId(!showCredentialId)}
            creationDate={creationDate}
            onCreationDateChange={setCreationDate}
            deviceInfo={deviceInfo}
            onDeviceInfoChange={setDeviceInfo}
            deviceInfoPlaceholder={tpk("deviceInfoPlaceholder")}
            notesLabel={base.entryCopy.notesLabel}
            notes={base.notes}
            onNotesChange={base.setNotes}
            notesPlaceholder={base.entryCopy.notesPlaceholder}
            labels={{
              relyingPartyId: tpk("relyingPartyId"),
              relyingPartyName: tpk("relyingPartyName"),
              username: tpk("username"),
              credentialId: tpk("credentialId"),
              creationDate: tpk("creationDate"),
              deviceInfo: tpk("deviceInfo"),
            }}
          />

          <TeamTagsAndFolderSection {...tagsAndFolderProps} />
          <EntryRepromptSection {...repromptSectionProps} />
          <EntryTravelSafeSection {...travelSafeSectionProps} />
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
