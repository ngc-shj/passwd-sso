"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PasswordGenerator } from "@/components/passwords/password-generator";
import { TOTPField, type TOTPEntry } from "@/components/passwords/totp-field";
import { OrgTagInput, type OrgTagData } from "./org-tag-input";
import {
  type GeneratorSettings,
  DEFAULT_GENERATOR_SETTINGS,
} from "@/lib/generator-prefs";
import {
  Eye,
  EyeOff,
  Loader2,
  Dices,
  Plus,
  X,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

export type CustomFieldType = "text" | "hidden" | "url";

export interface CustomField {
  label: string;
  value: string;
  type: CustomFieldType;
}

interface OrgPasswordFormProps {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  entryType?: "LOGIN" | "SECURE_NOTE";
  editData?: {
    id: string;
    entryType?: "LOGIN" | "SECURE_NOTE";
    title: string;
    username: string | null;
    password: string;
    content?: string;
    url: string | null;
    notes: string | null;
    tags?: OrgTagData[];
    customFields?: CustomField[];
    totp?: TOTPEntry | null;
  } | null;
}

export function OrgPasswordForm({
  orgId,
  open,
  onOpenChange,
  onSaved,
  entryType: entryTypeProp = "LOGIN",
  editData,
}: OrgPasswordFormProps) {
  const t = useTranslations("PasswordForm");
  const tn = useTranslations("SecureNoteForm");
  const tc = useTranslations("Common");
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);

  const isNote = (editData?.entryType ?? entryTypeProp) === "SECURE_NOTE";

  const [title, setTitle] = useState(editData?.title ?? "");
  const [username, setUsername] = useState(editData?.username ?? "");
  const [password, setPassword] = useState(editData?.password ?? "");
  const [content, setContent] = useState(editData?.content ?? "");
  const [url, setUrl] = useState(editData?.url ?? "");
  const [notes, setNotes] = useState(editData?.notes ?? "");
  const [selectedTags, setSelectedTags] = useState<OrgTagData[]>(
    editData?.tags ?? []
  );
  const [generatorSettings, setGeneratorSettings] = useState<GeneratorSettings>(
    { ...DEFAULT_GENERATOR_SETTINGS }
  );
  const [customFields, setCustomFields] = useState<CustomField[]>(
    editData?.customFields ?? []
  );
  const [totp, setTotp] = useState<TOTPEntry | null>(
    editData?.totp ?? null
  );
  const [showTotpInput, setShowTotpInput] = useState(!!editData?.totp);

  const isEdit = !!editData;

  // Sync form fields when editData changes (programmatic open)
  useEffect(() => {
    if (open && editData) {
      setTitle(editData.title);
      setUsername(editData.username ?? "");
      setPassword(editData.password ?? "");
      setContent(editData.content ?? "");
      setUrl(editData.url ?? "");
      setNotes(editData.notes ?? "");
      setSelectedTags(editData.tags ?? []);
      setCustomFields(editData.customFields ?? []);
      setTotp(editData.totp ?? null);
      setShowTotpInput(!!editData.totp);
    }
  }, [open, editData]);

  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setTitle("");
      setUsername("");
      setPassword("");
      setContent("");
      setUrl("");
      setNotes("");
      setSelectedTags([]);
      setCustomFields([]);
      setTotp(null);
      setShowTotpInput(false);
      setShowPassword(false);
      setShowGenerator(false);
      setSaving(false);
    } else if (editData) {
      setTitle(editData.title);
      setUsername(editData.username ?? "");
      setPassword(editData.password);
      setContent(editData.content ?? "");
      setUrl(editData.url ?? "");
      setNotes(editData.notes ?? "");
      setSelectedTags(editData.tags ?? []);
      setCustomFields(editData.customFields ?? []);
      setTotp(editData.totp ?? null);
      setShowTotpInput(!!editData.totp);
    }
    onOpenChange(v);
  };

  const handleSubmit = async () => {
    if (isNote) {
      if (!title.trim()) return;
    } else {
      if (!title.trim() || !password) return;
    }
    setSaving(true);

    try {
      const endpoint = isEdit
        ? `/api/orgs/${orgId}/passwords/${editData.id}`
        : `/api/orgs/${orgId}/passwords`;

      let body: Record<string, unknown>;

      if (isNote) {
        body = {
          entryType: "SECURE_NOTE",
          title: title.trim(),
          content,
          tagIds: selectedTags.map((t) => t.id),
        };
      } else {
        body = {
          title: title.trim(),
          username: username.trim() || undefined,
          password,
          url: url.trim() || undefined,
          notes: notes.trim() || undefined,
          tagIds: selectedTags.map((t) => t.id),
        };

        const validFields = customFields.filter(
          (f) => f.label.trim() && f.value.trim()
        );
        if (validFields.length > 0) {
          body.customFields = validFields;
        }
        if (totp) {
          body.totp = totp;
        } else {
          body.totp = null;
        }
      }

      const res = await fetch(endpoint, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error("Failed");

      toast.success(isEdit ? t("updated") : t("saved"));
      handleOpenChange(false);
      onSaved();
    } catch {
      toast.error(t("failedToSave"));
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isNote
              ? (isEdit ? tn("editNote") : tn("newNote"))
              : (isEdit ? t("editPassword") : t("newPassword"))}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {isNote
              ? (isEdit ? tn("editNote") : tn("newNote"))
              : (isEdit ? t("editPassword") : t("newPassword"))}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Title */}
          <div className="space-y-2">
            <Label>{isNote ? tn("title") : t("title")}</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={isNote ? tn("titlePlaceholder") : t("titlePlaceholder")}
            />
          </div>

          {isNote ? (
            <>
              {/* Content (Secure Note) */}
              <div className="space-y-2">
                <Label>{tn("content")}</Label>
                <Textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={tn("contentPlaceholder")}
                  rows={10}
                  maxLength={50000}
                  className="font-mono"
                />
              </div>

              {/* Tags (org tags) */}
              <div className="space-y-2">
                <Label>{tn("tags")}</Label>
                <OrgTagInput
                  orgId={orgId}
                  selectedTags={selectedTags}
                  onChange={setSelectedTags}
                />
              </div>
            </>
          ) : (
            <>
              {/* Username */}
              <div className="space-y-2">
                <Label>{t("usernameEmail")}</Label>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t("usernamePlaceholder")}
                  autoComplete="off"
                />
              </div>

              {/* Password with show/hide and generator */}
              <div className="space-y-2">
                <Label>{t("password")}</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={t("passwordPlaceholder")}
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

              {/* URL */}
              <div className="space-y-2">
                <Label>{t("url")}</Label>
                <Input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com"
                />
              </div>

              {/* Notes */}
              <div className="space-y-2">
                <Label>{t("notes")}</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t("notesPlaceholder")}
                  rows={3}
                />
              </div>

              {/* Tags (org tags) */}
              <div className="space-y-2">
                <Label>{t("tags")}</Label>
                <OrgTagInput
                  orgId={orgId}
                  selectedTags={selectedTags}
                  onChange={setSelectedTags}
                />
              </div>

              {/* Custom Fields */}
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
                  <div
                    key={idx}
                    className="flex items-start gap-2 rounded-md border p-2"
                  >
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
                            <SelectItem value="hidden">
                              {t("fieldHidden")}
                            </SelectItem>
                            <SelectItem value="url">{t("fieldUrl")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <Input
                        type={
                          field.type === "hidden"
                            ? "password"
                            : field.type === "url"
                              ? "url"
                              : "text"
                        }
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
            </>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <Button
            onClick={handleSubmit}
            disabled={saving || !title.trim() || (!isNote && !password)}
          >
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isEdit ? tc("update") : tc("save")}
          </Button>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            {tc("cancel")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
