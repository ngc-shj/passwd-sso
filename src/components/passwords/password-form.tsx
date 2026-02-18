"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { EntryCustomFieldsTotpSection } from "@/components/passwords/entry-custom-fields-totp-section";
import { PasswordFormPageShell } from "@/components/passwords/password-form-page-shell";
import { EntryRepromptSection } from "@/components/passwords/entry-reprompt-section";
import { EntryTagsAndFolderSection } from "@/components/passwords/entry-tags-and-folder-section";
import {
  EntryActionBar,
  EntrySectionCard,
  ENTRY_DIALOG_FLAT_SECTION_CLASS,
} from "@/components/passwords/entry-form-ui";
import { PersonalLoginFields } from "@/components/passwords/personal-login-fields";
import type { TagData } from "@/components/tags/tag-input";
import {
  type GeneratorSettings,
  DEFAULT_GENERATOR_SETTINGS,
} from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import { preventIMESubmit } from "@/lib/ime-guard";
import { usePersonalFolders } from "@/hooks/use-personal-folders";
import { buildGeneratorSummary } from "@/lib/generator-summary";
import {
  buildPersonalCurrentSnapshot,
  buildPersonalInitialSnapshot,
} from "@/components/passwords/personal-password-form-snapshot";
import type { PasswordFormProps } from "@/components/passwords/password-form-types";
import { submitPersonalPasswordForm } from "@/components/passwords/personal-password-submit";

export function PasswordForm({ mode, initialData, variant = "page", onSaved }: PasswordFormProps) {
  const t = useTranslations("PasswordForm");
  const tGen = useTranslations("PasswordGenerator");
  const tc = useTranslations("Common");
  const router = useRouter();
  const { encryptionKey, userId } = useVault();
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [title, setTitle] = useState(initialData?.title ?? "");
  const [username, setUsername] = useState(initialData?.username ?? "");
  const [password, setPassword] = useState(initialData?.password ?? "");
  const [url, setUrl] = useState(initialData?.url ?? "");
  const [notes, setNotes] = useState(initialData?.notes ?? "");
  const [selectedTags, setSelectedTags] = useState<TagData[]>(
    initialData?.tags ?? []
  );
  const [generatorSettings, setGeneratorSettings] = useState<GeneratorSettings>(
    initialData?.generatorSettings ?? { ...DEFAULT_GENERATOR_SETTINGS }
  );
  const [customFields, setCustomFields] = useState<EntryCustomField[]>(
    initialData?.customFields ?? []
  );
  const [totp, setTotp] = useState<EntryTotp | null>(
    initialData?.totp ?? null
  );
  const [showTotpInput, setShowTotpInput] = useState(!!initialData?.totp);
  const [requireReprompt, setRequireReprompt] = useState(initialData?.requireReprompt ?? false);
  const [folderId, setFolderId] = useState<string | null>(initialData?.folderId ?? null);
  const folders = usePersonalFolders();

  const initialSnapshot = buildPersonalInitialSnapshot(initialData);

  const currentSnapshot = buildPersonalCurrentSnapshot({
    title,
    username,
    password,
    url,
    notes,
    tags: selectedTags,
    generatorSettings,
    customFields,
    totp,
    requireReprompt,
    folderId,
  });
  const hasChanges = currentSnapshot !== initialSnapshot;
  const isDialogVariant = variant === "dialog";
  const dialogSectionClass = isDialogVariant ? ENTRY_DIALOG_FLAT_SECTION_CLASS : "";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitPersonalPasswordForm({
      mode,
      initialData,
      encryptionKey,
      userId: userId ?? undefined,
      title,
      username,
      password,
      url,
      notes,
      selectedTags,
      generatorSettings,
      customFields,
      totp,
      requireReprompt,
      folderId,
      setSubmitting,
      t,
      router,
      onSaved,
    });
  };

  const handleCancel = () => {
    if (onSaved) {
      onSaved();
    } else {
      router.back();
    }
  };

  const generatorSummary = buildGeneratorSummary(generatorSettings, {
    modePassphrase: tGen("modePassphrase"),
    modePassword: tGen("modePassword"),
  });

  const loginMainFields = (
    <PersonalLoginFields
      title={title}
      onTitleChange={setTitle}
      titleLabel={t("title")}
      titlePlaceholder={t("titlePlaceholder")}
      username={username}
      onUsernameChange={setUsername}
      usernameLabel={t("usernameEmail")}
      usernamePlaceholder={t("usernamePlaceholder")}
      password={password}
      onPasswordChange={setPassword}
      passwordLabel={t("password")}
      passwordPlaceholder={t("passwordPlaceholder")}
      showPassword={showPassword}
      onToggleShowPassword={() => setShowPassword((v) => !v)}
      generatorSummary={generatorSummary}
      showGenerator={showGenerator}
      onToggleGenerator={() => setShowGenerator((v) => !v)}
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
      onBack={() => router.back()}
      title={mode === "create" ? t("newPassword") : t("editPassword")}
    >
      {formContent}
    </PasswordFormPageShell>
  );
}
