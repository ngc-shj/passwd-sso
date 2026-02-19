"use client";

import { EntryCustomFieldsTotpSection } from "@/components/passwords/entry-custom-fields-totp-section";
import { PasswordFormPageShell } from "@/components/passwords/password-form-page-shell";
import { EntryRepromptSection } from "@/components/passwords/entry-reprompt-section";
import { EntryTagsAndFolderSection } from "@/components/passwords/entry-tags-and-folder-section";
import {
  EntryActionBar,
  EntrySectionCard,
  ENTRY_DIALOG_FLAT_SECTION_CLASS,
} from "@/components/passwords/entry-form-ui";
import { EntryLoginMainFields } from "@/components/passwords/entry-login-main-fields";
import { preventIMESubmit } from "@/lib/ime-guard";
import type { PasswordFormProps } from "@/components/passwords/password-form-types";
import { usePersonalPasswordFormModel } from "@/hooks/use-personal-password-form-model";
import { usePersonalFormSectionsProps } from "@/hooks/use-personal-form-sections-props";

export function PasswordForm({ mode, initialData, variant = "page", onSaved }: PasswordFormProps) {
  const {
    t,
    tc,
    formState,
    folders,
    hasChanges,
    loginMainFieldsProps,
    handleSubmit,
    handleCancel,
    handleBack,
  } = usePersonalPasswordFormModel({
    mode,
    initialData,
    onSaved,
  });
  const { values, setters } = formState;
  const isDialogVariant = variant === "dialog";
  const dialogSectionClass = isDialogVariant ? ENTRY_DIALOG_FLAT_SECTION_CLASS : "";
  const {
    tagsAndFolderProps,
    customFieldsTotpProps,
    repromptSectionProps,
    actionBarProps,
  } = usePersonalFormSectionsProps({
    tagsTitle: t("tags"),
    tagsHint: t("tagsHint"),
    folders,
    sectionCardClass: dialogSectionClass,
    repromptTitle: t("requireReprompt"),
    repromptDescription: t("requireRepromptHelp"),
    hasChanges,
    submitting: values.submitting,
    saveLabel: mode === "create" ? tc("save") : tc("update"),
    cancelLabel: tc("cancel"),
    statusUnsavedLabel: t("statusUnsaved"),
    statusSavedLabel: t("statusSaved"),
    onCancel: handleCancel,
    values,
    setters,
  });

  const loginMainFields = (
    <EntryLoginMainFields {...loginMainFieldsProps} />
  );

  const formContent = (
    <form onSubmit={handleSubmit} onKeyDown={preventIMESubmit} className="space-y-5">
      {isDialogVariant ? (
        loginMainFields
      ) : (
        <EntrySectionCard className="space-y-4 bg-gradient-to-b from-muted/30 to-background hover:bg-transparent">
          {loginMainFields}
        </EntrySectionCard>
      )}

      <EntryTagsAndFolderSection {...tagsAndFolderProps} />

      <EntryCustomFieldsTotpSection {...customFieldsTotpProps} />

      <EntryRepromptSection {...repromptSectionProps} />

      <EntryActionBar {...actionBarProps} />
    </form>
  );

  if (variant === "dialog") {
    return formContent;
  }

  return (
    <PasswordFormPageShell
      backLabel={tc("back")}
      onBack={handleBack}
      title={mode === "create" ? t("newPassword") : t("editPassword")}
    >
      {formContent}
    </PasswordFormPageShell>
  );
}
