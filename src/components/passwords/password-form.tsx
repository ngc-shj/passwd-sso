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
import { usePersonalEntryLoginFieldsProps } from "@/hooks/use-personal-entry-login-fields-props";
import { usePersonalPasswordFormModel } from "@/hooks/use-personal-password-form-model";

export function PasswordForm({ mode, initialData, variant = "page", onSaved }: PasswordFormProps) {
  const {
    t,
    tc,
    formState,
    folders,
    hasChanges,
    generatorSummary,
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
  const loginMainFieldsProps = usePersonalEntryLoginFieldsProps({
    formState,
    generatorSummary,
    translations: { t },
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

      <EntryTagsAndFolderSection
        tagsTitle={t("tags")}
        tagsHint={t("tagsHint")}
        selectedTags={values.selectedTags}
        onTagsChange={setters.setSelectedTags}
        folders={folders}
        folderId={values.folderId}
        onFolderChange={setters.setFolderId}
        sectionCardClass={dialogSectionClass}
      />

      <EntryCustomFieldsTotpSection
        customFields={values.customFields}
        setCustomFields={setters.setCustomFields}
        totp={values.totp}
        onTotpChange={setters.setTotp}
        showTotpInput={values.showTotpInput}
        setShowTotpInput={setters.setShowTotpInput}
        sectionCardClass={dialogSectionClass}
      />

      <EntryRepromptSection
        checked={values.requireReprompt}
        onCheckedChange={setters.setRequireReprompt}
        title={t("requireReprompt")}
        description={t("requireRepromptHelp")}
        sectionCardClass={dialogSectionClass}
      />

      <EntryActionBar
        hasChanges={hasChanges}
        submitting={values.submitting}
        saveLabel={mode === "create" ? tc("save") : tc("update")}
        cancelLabel={tc("cancel")}
        statusUnsavedLabel={t("statusUnsaved")}
        statusSavedLabel={t("statusSaved")}
        onCancel={handleCancel}
      />
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
