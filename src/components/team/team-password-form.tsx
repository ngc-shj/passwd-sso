"use client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
import { EntryCustomFieldsTotpSection } from "@/components/passwords/entry-custom-fields-totp-section";
import { EntryRepromptSection } from "@/components/passwords/entry-reprompt-section";
import { EntryExpirationSection } from "@/components/passwords/entry-expiration-section";
import { TeamAttachmentSection } from "./team-attachment-section";
import { TeamEntrySpecificFields } from "@/components/team/team-entry-specific-fields";
import { TeamTagsAndFolderSection } from "@/components/team/team-tags-and-folder-section";
import type { TeamPasswordFormProps } from "@/components/team/team-password-form-types";
import { preventIMESubmit } from "@/lib/ime-guard";
import { SECURE_NOTE_TEMPLATES } from "@/lib/secure-note-templates";
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
  defaultFolderId,
  defaultTags,
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
    teamPolicy,
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
    defaultFolderId,
    defaultTags,
  });
  const {
    values: { saving, title },
    setters: { setTitle, setContent },
  } = formState;
  const tSn = useTranslations("SecureNoteForm");
  const isSecureNote = entrySpecificFieldsProps.entryKind === "secureNote";
  const dialogSectionClass = ENTRY_DIALOG_FLAT_SECTION_CLASS;
  const { tagsAndFolderProps, customFieldsTotpProps, repromptSectionProps, expirationSectionProps, actionBarProps } = buildTeamFormSectionsProps({
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
    repromptTitle: t("requireReprompt"),
    repromptDescription: t("requireRepromptHelp"),
    repromptPolicyForced: teamPolicy?.requireRepromptForAll,
    repromptPolicyForcedLabel: teamPolicy?.requireRepromptForAll ? t("requireRepromptPolicyForced") : undefined,
    expirationTitle: t("expirationTitle"),
    expirationDescription: t("expirationDescription"),
    onCancel: () => handleOpenChange(false),
    values: formState.values,
    setters: formState.setters,
  });

  const entrySpecificFields = <TeamEntrySpecificFields {...entrySpecificFieldsProps} teamPolicy={teamPolicy} />;

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
          {!isEdit && isSecureNote && (
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
                    setTitle("");
                    setContent("");
                    return;
                  }
                  setTitle(tSn(tmpl.titleKey));
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

          <EntryRepromptSection {...repromptSectionProps} />
          <EntryExpirationSection {...expirationSectionProps} />

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
