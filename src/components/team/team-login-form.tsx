"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EntryLoginMainFields } from "@/components/passwords/entry-login-main-fields";
import { EntryCustomFieldsTotpSection } from "@/components/passwords/entry-custom-fields-totp-section";
import { EntryRepromptSection } from "@/components/passwords/entry-reprompt-section";
import { EntryExpirationSection } from "@/components/passwords/entry-expiration-section";
import { TeamAttachmentSection } from "./team-attachment-section";
import { TeamTagsAndFolderSection } from "@/components/team/team-tags-and-folder-section";
import type { TeamEntryFormProps } from "@/components/team/team-entry-form-types";
import { preventIMESubmit } from "@/lib/ime-guard";
import { EntryActionBar } from "@/components/passwords/entry-form-ui";
import { useTeamLoginFormModel } from "@/hooks/use-team-login-form-model";

export function TeamLoginForm({
  teamId,
  open,
  onOpenChange,
  onSaved,
  entryType,
  editData,
  defaultFolderId,
  defaultTags,
}: TeamEntryFormProps) {
  const {
    base,
    loginMainFieldsProps,
    customFieldsTotpProps,
    tagsAndFolderProps,
    repromptSectionProps,
    expirationSectionProps,
    actionBarProps,
    handleFormSubmit,
  } = useTeamLoginFormModel({
    teamId,
    open,
    onOpenChange,
    onSaved,
    entryType,
    editData,
    defaultFolderId,
    defaultTags,
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
