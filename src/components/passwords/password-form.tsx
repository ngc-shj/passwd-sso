"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { encryptData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD, AAD_VERSION } from "@/lib/crypto-aad";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PasswordGenerator } from "./password-generator";
import { TOTPField, type TOTPEntry } from "./totp-field";
import { TagInput, type TagData } from "@/components/tags/tag-input";
import { EntryActionBar, EntryPrimaryCard, EntrySectionCard } from "@/components/passwords/entry-form-ui";
import {
  type GeneratorSettings,
  DEFAULT_GENERATOR_SETTINGS,
} from "@/lib/generator-prefs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Eye, EyeOff, ArrowLeft, Dices, Plus, X, ShieldCheck, Tags, Rows3, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { API_PATH, CUSTOM_FIELD_TYPE, apiPath } from "@/lib/constants";
import type { CustomFieldType } from "@/lib/constants";
import { preventIMESubmit } from "@/lib/ime-guard";
import {
  extractTagIds,
  filterNonEmptyCustomFields,
  parseUrlHost,
  toTagNameColor,
} from "@/lib/entry-form-helpers";
import type { FolderItem } from "@/components/folders/folder-tree";

export interface CustomField {
  label: string;
  value: string;
  type: CustomFieldType;
}

export interface PasswordHistoryEntry {
  password: string;
  changedAt: string;
}

export type { TOTPEntry };

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
    passwordHistory?: PasswordHistoryEntry[];
    customFields?: CustomField[];
    totp?: TOTPEntry;
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
  const [customFields, setCustomFields] = useState<CustomField[]>(
    initialData?.customFields ?? []
  );
  const [totp, setTotp] = useState<TOTPEntry | null>(
    initialData?.totp ?? null
  );
  const [showTotpInput, setShowTotpInput] = useState(!!initialData?.totp);
  const [requireReprompt, setRequireReprompt] = useState(initialData?.requireReprompt ?? false);
  const [folderId, setFolderId] = useState<string | null>(initialData?.folderId ?? null);
  const [folders, setFolders] = useState<FolderItem[]>([]);

  // Fetch folders for the folder selector
  useEffect(() => {
    fetch(API_PATH.FOLDERS)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => { if (Array.isArray(data)) setFolders(data); })
      .catch(() => {});
  }, []);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!encryptionKey) return;
    setSubmitting(true);

    try {
      const urlHost = parseUrlHost(url);
      const tags = toTagNameColor(selectedTags);
      const validCustomFields = filterNonEmptyCustomFields(customFields);

      // Build password history on edit
      let passwordHistory: PasswordHistoryEntry[] =
        initialData?.passwordHistory ?? [];
      if (
        mode === "edit" &&
        initialData &&
        password !== initialData.password
      ) {
        passwordHistory = [
          { password: initialData.password, changedAt: new Date().toISOString() },
          ...passwordHistory,
        ].slice(0, 10); // Keep max 10 entries
      }

      const fullBlob = JSON.stringify({
        title,
        username: username || null,
        password,
        url: url || null,
        notes: notes || null,
        tags,
        generatorSettings,
        ...(passwordHistory.length > 0 && { passwordHistory }),
        ...(validCustomFields.length > 0 && { customFields: validCustomFields }),
        ...(totp && { totp }),
      });

      const overviewBlob = JSON.stringify({
        title,
        username: username || null,
        urlHost,
        tags,
        requireReprompt,
      });

      // For create: generate client-side UUID for AAD binding
      // For edit: use existing entry ID, re-encrypt with AAD (save-time migration)
      const entryId = mode === "create" ? crypto.randomUUID() : initialData!.id;
      const aad = userId ? buildPersonalEntryAAD(userId, entryId) : undefined;

      const encryptedBlob = await encryptData(fullBlob, encryptionKey, aad);
      const encryptedOverview = await encryptData(overviewBlob, encryptionKey, aad);

      const body = {
        ...(mode === "create" ? { id: entryId } : {}),
        encryptedBlob,
        encryptedOverview,
        keyVersion: 1,
        aadVersion: aad ? AAD_VERSION : 0,
        tagIds: extractTagIds(selectedTags),
        requireReprompt,
        folderId: folderId ?? null,
      };

      const endpoint =
        mode === "create"
          ? API_PATH.PASSWORDS
          : apiPath.passwordById(initialData!.id);
      const method = mode === "create" ? "POST" : "PUT";

      const res = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        toast.success(mode === "create" ? t("saved") : t("updated"));
        if (onSaved) {
          onSaved();
        } else {
          router.push("/dashboard");
          router.refresh();
        }
      } else {
        toast.error(t("failedToSave"));
      }
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
            <EntryPrimaryCard>
            <div className="space-y-2">
              <Label htmlFor="title">{t("title")}</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("titlePlaceholder")}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="username">{t("usernameEmail")}</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t("usernamePlaceholder")}
                autoComplete="off"
              />
            </div>

            <div className="space-y-2 rounded-lg border bg-background/70 p-3">
              <Label htmlFor="password">{t("password")}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("passwordPlaceholder")}
                    required
                    autoComplete="off"
                  />
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 flex">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
                <p className="text-xs text-muted-foreground">{generatorSummary}</p>
                <Button
                  type="button"
                  variant={showGenerator ? "secondary" : "outline"}
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => setShowGenerator((v) => !v)}
                >
                  <Dices className="h-3.5 w-3.5" />
                  {showGenerator ? t("closeGenerator") : t("openGenerator")}
                </Button>
              </div>
              <PasswordGenerator
                open={showGenerator}
                onClose={() => setShowGenerator(false)}
                settings={generatorSettings}
                onUse={(pw, settings) => {
                  setPassword(pw);
                  setShowPassword(true);
                  setGeneratorSettings(settings);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="url">{t("url")}</Label>
              <Input
                id="url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">{t("notes")}</Label>
              <textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("notesPlaceholder")}
                rows={3}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
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

            {/* Folder assignment */}
            {folders.length > 0 && (
              <EntrySectionCard>
                <div className="space-y-1">
                  <Label className="flex items-center gap-2">
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t("folder")}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t("folderHint")}</p>
                </div>
                <Select
                  value={folderId ?? "__none__"}
                  onValueChange={(v) => setFolderId(v === "__none__" ? null : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">{t("noFolder")}</SelectItem>
                    {folders.map((f) => {
                      // Compute depth for hierarchy indentation
                      let depth = 0;
                      let current: FolderItem | undefined = f;
                      while (current?.parentId) {
                        depth++;
                        current = folders.find((p) => p.id === current!.parentId);
                      }
                      const indent = depth > 0 ? "\u00A0\u00A0".repeat(depth) + "└ " : "";
                      return (
                        <SelectItem key={f.id} value={f.id}>
                          {indent}{f.name}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </EntrySectionCard>
            )}

            {/* Custom fields */}
            <EntrySectionCard>
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label className="flex items-center gap-2">
                    <Rows3 className="h-3.5 w-3.5" />
                    {t("customFields")}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t("customFieldsHint")}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={() =>
                    setCustomFields((prev) => [
                      ...prev,
                      { label: "", value: "", type: CUSTOM_FIELD_TYPE.TEXT },
                    ])
                  }
                >
                  <Plus className="h-3 w-3" />
                  {t("addField")}
                </Button>
              </div>
              {customFields.map((field, idx) => (
                <div key={idx} className="flex items-start gap-2 rounded-lg border p-2">
                  <div className="flex-1 space-y-2">
                    <div className="flex gap-2">
                      <Input
                        value={field.label}
                        onChange={(e) =>
                          setCustomFields((prev) =>
                            prev.map((f, i) =>
                              i === idx ? { ...f, label: e.target.value } : f
                            )
                          )
                        }
                        placeholder={t("fieldLabel")}
                        className="h-8 text-sm"
                      />
                      <Select
                        value={field.type}
                        onValueChange={(v: CustomFieldType) =>
                          setCustomFields((prev) =>
                            prev.map((f, i) =>
                              i === idx ? { ...f, type: v } : f
                            )
                          )
                        }
                      >
                        <SelectTrigger className="h-8 w-28 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={CUSTOM_FIELD_TYPE.TEXT}>{t("fieldText")}</SelectItem>
                          <SelectItem value={CUSTOM_FIELD_TYPE.HIDDEN}>{t("fieldHidden")}</SelectItem>
                          <SelectItem value={CUSTOM_FIELD_TYPE.URL}>{t("fieldUrl")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Input
                      type={field.type === CUSTOM_FIELD_TYPE.HIDDEN ? "password" : field.type === CUSTOM_FIELD_TYPE.URL ? "url" : "text"}
                      value={field.value}
                      onChange={(e) =>
                        setCustomFields((prev) =>
                          prev.map((f, i) =>
                            i === idx ? { ...f, value: e.target.value } : f
                          )
                        )
                      }
                      placeholder={t("fieldValue")}
                      className="h-8 text-sm"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      setCustomFields((prev) => prev.filter((_, i) => i !== idx))
                    }
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </EntrySectionCard>

            {/* TOTP */}
            <EntrySectionCard>
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label className="flex items-center gap-1">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {t("totp")}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t("totpHint")}</p>
                </div>
                {!showTotpInput && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={() => setShowTotpInput(true)}
                  >
                    <Plus className="h-3 w-3" />
                    {t("addTotp")}
                  </Button>
                )}
              </div>
              {showTotpInput && (
                <TOTPField
                  mode="input"
                  totp={totp}
                  onChange={setTotp}
                  onRemove={() => setShowTotpInput(false)}
                />
              )}
            </EntrySectionCard>

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
