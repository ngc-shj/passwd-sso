"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { encryptData } from "@/lib/crypto-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PasswordGenerator } from "./password-generator";
import { TOTPField, type TOTPEntry } from "./totp-field";
import { TagInput, type TagData } from "@/components/tags/tag-input";
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
import { Eye, EyeOff, Loader2, ArrowLeft, Dices, Plus, X, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

export type CustomFieldType = "text" | "hidden" | "url";

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
  };
  variant?: "page" | "dialog";
  onSaved?: () => void;
}

export function PasswordForm({ mode, initialData, variant = "page", onSaved }: PasswordFormProps) {
  const t = useTranslations("PasswordForm");
  const tc = useTranslations("Common");
  const router = useRouter();
  const { encryptionKey } = useVault();
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!encryptionKey) return;
    setSubmitting(true);

    try {
      let urlHost: string | null = null;
      if (url) {
        try {
          urlHost = new URL(url).hostname;
        } catch {
          /* invalid url */
        }
      }

      const tags = selectedTags.map((t) => ({
        name: t.name,
        color: t.color,
      }));

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
        ...(customFields.length > 0 && { customFields }),
        ...(totp && { totp }),
      });

      const overviewBlob = JSON.stringify({
        title,
        username: username || null,
        urlHost,
        tags,
      });

      const encryptedBlob = await encryptData(fullBlob, encryptionKey);
      const encryptedOverview = await encryptData(overviewBlob, encryptionKey);

      const body = {
        encryptedBlob,
        encryptedOverview,
        keyVersion: 1,
        tagIds: selectedTags.map((t) => t.id),
      };

      const endpoint =
        mode === "create"
          ? "/api/passwords"
          : `/api/passwords/${initialData!.id}`;
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

  const formContent = (
          <form onSubmit={handleSubmit} className="space-y-4">
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

            <div className="space-y-2">
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setShowGenerator(!showGenerator)}
                    >
                      <Dices className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
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
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            {/* Tags section - 1Password style */}
            <div className="space-y-2">
              <Label>{t("tags")}</Label>
              <TagInput
                selectedTags={selectedTags}
                onChange={setSelectedTags}
              />
            </div>

            {/* Custom fields */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t("customFields")}</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={() =>
                    setCustomFields((prev) => [
                      ...prev,
                      { label: "", value: "", type: "text" },
                    ])
                  }
                >
                  <Plus className="h-3 w-3" />
                  {t("addField")}
                </Button>
              </div>
              {customFields.map((field, idx) => (
                <div key={idx} className="flex items-start gap-2 rounded-md border p-2">
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
                          <SelectItem value="text">{t("fieldText")}</SelectItem>
                          <SelectItem value="hidden">{t("fieldHidden")}</SelectItem>
                          <SelectItem value="url">{t("fieldUrl")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Input
                      type={field.type === "hidden" ? "password" : field.type === "url" ? "url" : "text"}
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
            </div>

            {/* TOTP */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {t("totp")}
                </Label>
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
            </div>

            <div className="flex gap-2 pt-4">
              <Button type="submit" disabled={submitting}>
                {submitting && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                {mode === "create" ? tc("save") : tc("update")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleCancel}
              >
                {tc("cancel")}
              </Button>
            </div>
          </form>
  );

  if (variant === "dialog") {
    return formContent;
  }

  return (
    <div className="mx-auto max-w-2xl p-4 md:p-6">
      <Button
        variant="ghost"
        className="mb-4 gap-2"
        onClick={() => router.back()}
      >
        <ArrowLeft className="h-4 w-4" />
        {tc("back")}
      </Button>

      <Card>
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
  );
}
