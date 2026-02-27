"use client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EntryCustomFieldsTotpSection } from "@/components/passwords/entry-custom-fields-totp-section";
import { TeamAttachmentSection } from "./team-attachment-section";
import { TeamEntrySpecificFields } from "@/components/team/team-entry-specific-fields";
import { TeamTagsAndFolderSection } from "@/components/team/team-tags-and-folder-section";
import type { TeamPasswordFormProps } from "@/components/team/team-password-form-types";
import { preventIMESubmit } from "@/lib/ime-guard";
import {
  EntryActionBar,
  ENTRY_DIALOG_FLAT_SECTION_CLASS,
} from "@/components/passwords/entry-form-ui";
import { useTeamPasswordFormModel } from "@/hooks/use-team-password-form-model";
import { buildTeamFormSectionsProps } from "@/hooks/team-form-sections-props";

export function TeamPasswordForm({
  teamId,
  open,
  onOpenChange,
  onSaved,
  entryType,
  editData,
}: TeamPasswordFormProps) {
  const scopedId = teamId;
  const {
    t,
    tc,
    isEdit,
    isLoginEntry,
    formState,
    attachments,
    setAttachments,
    teamFolders,
    handleOpenChange,
    entryCopy,
    entrySpecificFieldsProps,
    handleSubmit,
    hasChanges,
    submitDisabled,
  } = useTeamPasswordFormModel({
    teamId: scopedId,
    open,
    onOpenChange,
    onSaved,
    entryType,
    editData,
  });
  const {
    values: { saving, title },
    setters: { setTitle },
  } = formState;
  const dialogSectionClass = ENTRY_DIALOG_FLAT_SECTION_CLASS;
  const { tagsAndFolderProps, customFieldsTotpProps, actionBarProps } = buildTeamFormSectionsProps({
    teamId: scopedId,
    tagsTitle: entryCopy.tagsTitle,
    tagsHint: t("tagsHint"),
    folders: teamFolders,
    sectionCardClass: dialogSectionClass,
    isLoginEntry,
    hasChanges,
    saving,
    submitDisabled,
    saveLabel: isEdit ? tc("update") : tc("save"),
    cancelLabel: tc("cancel"),
    statusUnsavedLabel: t("statusUnsaved"),
    statusSavedLabel: t("statusSaved"),
    onCancel: () => handleOpenChange(false),
    values: formState.values,
    setters: formState.setters,
  });

  const entrySpecificFields = <TeamEntrySpecificFields {...entrySpecificFieldsProps} />;

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void handleSubmit();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{entryCopy.dialogLabel}</DialogTitle>
          <DialogDescription className="sr-only">{entryCopy.dialogLabel}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleFormSubmit} onKeyDown={preventIMESubmit} className="space-y-5">
          <div className="space-y-2">
            <Label>{entryCopy.titleLabel}</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={entryCopy.titlePlaceholder}
            />
          </div>

          {entrySpecificFields}

          <TeamTagsAndFolderSection {...tagsAndFolderProps} />

          {customFieldsTotpProps && (
            <EntryCustomFieldsTotpSection {...customFieldsTotpProps} />
          )}

          <EntryActionBar {...actionBarProps} />
        </form>

        {isEdit && editData && (
          <div className="border-t pt-4">
            <TeamAttachmentSection
              teamId={scopedId}
              entryId={editData.id}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
