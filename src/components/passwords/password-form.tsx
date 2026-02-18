"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TagInput, type TagData } from "@/components/tags/tag-input";
import { EntryCustomFieldsTotpSection } from "@/components/passwords/entry-custom-fields-totp-section";
import { EntryFolderSelectSection } from "@/components/passwords/entry-folder-select-section";
import { EntryActionBar, EntryPrimaryCard, EntrySectionCard } from "@/components/passwords/entry-form-ui";
import { EntryLoginMainFields } from "@/components/passwords/entry-login-main-fields";
import {
  type GeneratorSettings,
  DEFAULT_GENERATOR_SETTINGS,
} from "@/lib/generator-prefs";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowLeft, ShieldCheck, Tags } from "lucide-react";
import { toast } from "sonner";
import type { EntryCustomField, EntryPasswordHistory, EntryTotp } from "@/lib/entry-form-types";
import { preventIMESubmit } from "@/lib/ime-guard";
import {
  extractTagIds,
} from "@/lib/entry-form-helpers";
import {
  buildPasswordHistory,
  buildPersonalEntryPayload,
} from "@/lib/personal-entry-payload";
import { usePersonalFolders } from "@/hooks/use-personal-folders";
import { savePersonalEntry } from "@/lib/personal-entry-save";
import { handlePersonalSaveFeedback } from "@/components/passwords/personal-save-feedback";

interface PasswordFormProps {
  mode: "create" | "edit";
  initialData?: {
    id: string;
    title: string;
    username: string;
    password: string;
    url: string;
    notes: string;
    tags: TagData[];
    generatorSettings?: GeneratorSettings;
    passwordHistory?: EntryPasswordHistory[];
    customFields?: EntryCustomField[];
    totp?: EntryTotp;
    requireReprompt?: boolean;
    folderId?: string | null;
  };
  variant?: "page" | "dialog";
  onSaved?: () => void;
}

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

  const initialSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: initialData?.title ?? "",
        username: initialData?.username ?? "",
        password: initialData?.password ?? "",
        url: initialData?.url ?? "",
        notes: initialData?.notes ?? "",
        tags: initialData?.tags ?? [],
        generatorSettings:
          initialData?.generatorSettings ?? { ...DEFAULT_GENERATOR_SETTINGS },
        customFields: initialData?.customFields ?? [],
        totp: initialData?.totp ?? null,
        requireReprompt: initialData?.requireReprompt ?? false,
        folderId: initialData?.folderId ?? null,
      }),
    [initialData]
  );

  const currentSnapshot = JSON.stringify({
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
  const primaryCardClass = isDialogVariant ? "!border-0 !bg-none" : "";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!encryptionKey) return;
    setSubmitting(true);

    try {
      const existingHistory = buildPasswordHistory(
        mode === "edit" && initialData ? initialData.password : "",
        password,
        initialData?.passwordHistory ?? [],
        new Date().toISOString()
      );
      const { fullBlob, overviewBlob } = buildPersonalEntryPayload({
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
        existingHistory,
      });

      const res = await savePersonalEntry({
        mode,
        initialId: initialData?.id,
        encryptionKey,
        userId: userId ?? undefined,
        fullBlob,
        overviewBlob,
        tagIds: extractTagIds(selectedTags),
        requireReprompt,
        folderId: folderId ?? null,
      });

      handlePersonalSaveFeedback({ res, mode, t, router, onSaved });
    } catch {
      toast.error(t("networkError"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (onSaved) {
      onSaved();
    } else {
      router.back();
    }
  };

  const generatorSummary =
    generatorSettings.mode === "passphrase"
      ? `${tGen("modePassphrase")} · ${generatorSettings.passphrase.wordCount}`
      : `${tGen("modePassword")} · ${generatorSettings.length}`;

  const formContent = (
          <form onSubmit={handleSubmit} onKeyDown={preventIMESubmit} className="space-y-5">
            <EntryPrimaryCard className={primaryCardClass}>
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
            </EntryPrimaryCard>

            {/* Tags section - 1Password style */}
            <EntrySectionCard>
              <div className="space-y-1">
                <Label className="flex items-center gap-2">
                  <Tags className="h-3.5 w-3.5" />
                  {t("tags")}
                </Label>
                <p className="text-xs text-muted-foreground">{t("tagsHint")}</p>
              </div>
              <TagInput
                selectedTags={selectedTags}
                onChange={setSelectedTags}
              />
            </EntrySectionCard>

            <EntryCustomFieldsTotpSection
              customFields={customFields}
              setCustomFields={setCustomFields}
              totp={totp}
              onTotpChange={setTotp}
              showTotpInput={showTotpInput}
              setShowTotpInput={setShowTotpInput}
            />

            <EntryFolderSelectSection
              folders={folders}
              value={folderId}
              onChange={setFolderId}
            />

            {/* Reprompt */}
            <EntrySectionCard>
              <label className="flex items-center gap-3 cursor-pointer" htmlFor="require-reprompt">
                <Checkbox
                  id="require-reprompt"
                  checked={requireReprompt}
                  onCheckedChange={(v) => setRequireReprompt(!!v)}
                />
                <div className="space-y-0.5">
                  <span className="text-sm font-medium flex items-center gap-1.5">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {t("requireReprompt")}
                  </span>
                  <p className="text-xs text-muted-foreground">{t("requireRepromptHelp")}</p>
                </div>
              </label>
            </EntrySectionCard>

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
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-4">
      <Button
        variant="ghost"
        className="mb-4 gap-2"
        onClick={() => router.back()}
      >
        <ArrowLeft className="h-4 w-4" />
        {tc("back")}
      </Button>

      <Card className="rounded-xl border">
        <CardHeader>
          <CardTitle>
            {mode === "create" ? t("newPassword") : t("editPassword")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {formContent}
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
