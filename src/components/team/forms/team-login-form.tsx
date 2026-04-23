"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EntryLoginMainFields } from "@/components/passwords/entry/entry-login-main-fields";
import { EntryCustomFieldsTotpSection } from "@/components/passwords/entry/entry-custom-fields-totp-section";
import { EntryRepromptSection } from "@/components/passwords/entry/entry-reprompt-section";
import { EntryTravelSafeSection } from "@/components/passwords/entry/entry-travel-safe-section";
import { EntryExpirationSection } from "@/components/passwords/entry/entry-expiration-section";
import { TeamAttachmentSection } from "./team-attachment-section";
import { TeamTagsAndFolderSection } from "@/components/team/forms/team-tags-and-folder-section";
import type { TeamEntryFormProps } from "@/components/team/forms/team-entry-form-types";
import { preventIMESubmit } from "@/lib/ui/ime-guard";
import { EntryActionBar } from "@/components/passwords/entry/entry-form-ui";
import { useTeamLoginFormModel } from "@/hooks/team/use-team-login-form-model";

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
    travelSafeSectionProps,
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
