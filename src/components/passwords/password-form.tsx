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

export function PasswordForm({ mode, initialData, variant = "page", onSaved }: PasswordFormProps) {
  const {
    t,
    tc,
    submitting,
    title,
    username,
    password,
    url,
    notes,
    selectedTags,
    generatorSettings,
    customFields,
    totp,
    showTotpInput,
    requireReprompt,
    folderId,
    folders,
    showPassword,
    showGenerator,
    hasChanges,
    generatorSummary,
    setTitle,
    setUsername,
    setPassword,
    setUrl,
    setNotes,
    setSelectedTags,
    setGeneratorSettings,
    setCustomFields,
    setTotp,
    setShowTotpInput,
    setRequireReprompt,
    setFolderId,
    setShowPassword,
    setShowGenerator,
    handleSubmit,
    handleCancel,
    handleBack,
  } = usePersonalPasswordFormModel({
    mode,
    initialData,
    onSaved,
  });
  const isDialogVariant = variant === "dialog";
  const dialogSectionClass = isDialogVariant ? ENTRY_DIALOG_FLAT_SECTION_CLASS : "";

  const loginMainFields = (
    <EntryLoginMainFields
      title={title}
      onTitleChange={setTitle}
      titleLabel={t("title")}
      titlePlaceholder={t("titlePlaceholder")}
      titleRequired
      username={username}
      onUsernameChange={setUsername}
      usernameLabel={t("usernameEmail")}
      usernamePlaceholder={t("usernamePlaceholder")}
      password={password}
      onPasswordChange={setPassword}
      passwordLabel={t("password")}
      passwordPlaceholder={t("passwordPlaceholder")}
      passwordRequired
      showPassword={showPassword}
      onToggleShowPassword={() => setShowPassword(!showPassword)}
      generatorSummary={generatorSummary}
      showGenerator={showGenerator}
      onToggleGenerator={() => setShowGenerator(!showGenerator)}
      closeGeneratorLabel={t("closeGenerator")}
      openGeneratorLabel={t("openGenerator")}
      generatorSettings={generatorSettings}
      onGeneratorUse={(pw, settings) => {
        setPassword(pw);
        setShowPassword(true);
        setGeneratorSettings(settings);
      }}
      url={url}
      onUrlChange={setUrl}
      urlLabel={t("url")}
      notes={notes}
      onNotesChange={setNotes}
      notesLabel={t("notes")}
      notesPlaceholder={t("notesPlaceholder")}
    />
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
              selectedTags={selectedTags}
              onTagsChange={setSelectedTags}
              folders={folders}
              folderId={folderId}
              onFolderChange={setFolderId}
              sectionCardClass={dialogSectionClass}
            />

            <EntryCustomFieldsTotpSection
              customFields={customFields}
              setCustomFields={setCustomFields}
              totp={totp}
              onTotpChange={setTotp}
              showTotpInput={showTotpInput}
              setShowTotpInput={setShowTotpInput}
              sectionCardClass={dialogSectionClass}
            />

            <EntryRepromptSection
              checked={requireReprompt}
              onCheckedChange={setRequireReprompt}
              title={t("requireReprompt")}
              description={t("requireRepromptHelp")}
              sectionCardClass={dialogSectionClass}
            />

            <EntryActionBar
              hasChanges={hasChanges}
              submitting={submitting}
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
