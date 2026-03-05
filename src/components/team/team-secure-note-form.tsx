"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SecureNoteFields } from "@/components/entry-fields/secure-note-fields";
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
import { SECURE_NOTE_TEMPLATES } from "@/lib/secure-note-templates";
import { ENTRY_TYPE } from "@/lib/constants";
import { useTeamBaseFormModel } from "@/hooks/use-team-base-form-model";
import { buildTeamFormSectionsProps } from "@/hooks/team-form-sections-props";

export function TeamSecureNoteForm({
  teamId,
  open,
  onOpenChange,
  onSaved,
  entryType,
  editData,
  defaultFolderId,
  defaultTags,
}: TeamEntryFormProps) {
  const tSn = useTranslations("SecureNoteForm");
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
  const [content, setContent] = useState(editData?.content ?? "");

  // hasChanges
  const baselineSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: editData?.title ?? "",
        notes: editData?.notes ?? "",
        content: editData?.content ?? "",
        selectedTagIds: (editData?.tags ?? defaultTags ?? [])
          .map((tag) => tag.id)
          .sort(),
        teamFolderId: editData?.teamFolderId ?? defaultFolderId ?? null,
        requireReprompt: editData?.requireReprompt ?? false,
        travelSafe: editData?.travelSafe ?? true,
        expiresAt: editData?.expiresAt ?? null,
      }),
    [editData, defaultFolderId, defaultTags],
  );

  const currentSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: base.title,
        notes: base.notes,
        content,
        selectedTagIds: base.selectedTags.map((tag) => tag.id).sort(),
        teamFolderId: base.teamFolderId,
        requireReprompt: base.requireReprompt,
        travelSafe: base.travelSafe,
        expiresAt: base.expiresAt,
      }),
    [
      base.title,
      base.notes,
      content,
      base.selectedTags,
      base.teamFolderId,
      base.requireReprompt,
      base.travelSafe,
      base.expiresAt,
    ],
  );

  const hasChanges = currentSnapshot !== baselineSnapshot;
  const submitDisabled = !base.title.trim();

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
      entryType: ENTRY_TYPE.SECURE_NOTE,
      title: base.title,
      notes: base.notes,
      tagNames,
      content,
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
          {!base.isEdit && (
            <div className="space-y-2">
              <Label>{tSn("templateLabel")}</Label>
              <Select
                defaultValue="blank"
                onValueChange={(templateId) => {
                  const tmpl = SECURE_NOTE_TEMPLATES.find(
                    (tp) => tp.id === templateId,
                  );
                  if (!tmpl) return;
                  if (tmpl.id === "blank") {
                    base.setTitle("");
                    setContent("");
                    return;
                  }
                  base.setTitle(tSn(tmpl.titleKey));
                  setContent(tmpl.contentTemplate);
                }}
              >
                <SelectTrigger className="w-full max-w-[300px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SECURE_NOTE_TEMPLATES.map((tmpl) => (
                    <SelectItem key={tmpl.id} value={tmpl.id}>
                      {tSn(tmpl.titleKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label>{base.entryCopy.titleLabel}</Label>
            <Input
              value={base.title}
              onChange={(e) => base.setTitle(e.target.value)}
              placeholder={base.entryCopy.titlePlaceholder}
            />
          </div>

          <SecureNoteFields
            idPrefix="team-"
            content={content}
            onContentChange={setContent}
            contentLabel={tSn("content")}
            contentPlaceholder={tSn("contentPlaceholder")}
            editTabLabel={tSn("editTab")}
            previewTabLabel={tSn("previewTab")}
            markdownHint={tSn("markdownHint")}
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
