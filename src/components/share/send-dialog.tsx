"use client";

import { useState, useRef } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import {
  Loader2,
  Copy,
  Check,
  Send,
  Upload,
  MessageSquare,
  Paperclip,
  Lock,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { apiErrorToI18nKey } from "@/lib/api-error-codes";
import { API_PATH } from "@/lib/constants";
import { SEND_MAX_FILE_SIZE, SEND_MAX_TEXT_LENGTH, MAX_VIEWS_MIN, MAX_VIEWS_MAX, SEND_NAME_MAX_LENGTH } from "@/lib/validations";
import { formatFileSize } from "@/lib/format-file-size";
import { fetchApi, appUrl } from "@/lib/url-helpers";

interface SendDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}

const EXPIRY_OPTIONS = ["1h", "1d", "7d", "30d"] as const;

export function SendDialog({ open, onOpenChange, onCreated }: SendDialogProps) {
  const t = useTranslations("Share");
  const tApi = useTranslations("ApiErrors");

  // Common state
  const [tab, setTab] = useState<string>("text");
  const [name, setName] = useState("");
  const [expiresIn, setExpiresIn] = useState<string>("1d");
  const [maxViews, setMaxViews] = useState<string>("");
  const [requirePassword, setRequirePassword] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [createdAccessPassword, setCreatedAccessPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [passwordCopied, setPasswordCopied] = useState(false);

  // Text tab
  const [text, setText] = useState("");

  // File tab
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setName("");
    setText("");
    setFile(null);
    setExpiresIn("1d");
    setMaxViews("");
    setRequirePassword(false);
    setCreatedUrl(null);
    setCreatedAccessPassword(null);
    setCopied(false);
    setPasswordCopied(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) resetForm();
    onOpenChange(nextOpen);
  };

  const handleCreateText = async () => {
    setCreating(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        text,
        expiresIn,
      };
      if (maxViews) {
        const mv = parseInt(maxViews, 10);
        if (mv >= MAX_VIEWS_MIN && mv <= MAX_VIEWS_MAX) body.maxViews = mv;
      }
      if (requirePassword) body.requirePassword = true;

      const res = await fetchApi(API_PATH.SENDS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(tApi(apiErrorToI18nKey(err?.error)));
        return;
      }

      const data = await res.json();
      const fullUrl = appUrl(data.url);
      setCreatedUrl(fullUrl);
      if (data.accessPassword) setCreatedAccessPassword(data.accessPassword);
      onCreated?.();
      toast.success(t("sendCreateSuccess"));
    } catch {
      toast.error(tApi("unknownError"));
    } finally {
      setCreating(false);
    }
  };

  const handleCreateFile = async () => {
    if (!file) return;
    setCreating(true);
    try {
      const formData = new FormData();
      formData.append("name", name.trim());
      formData.append("file", file);
      formData.append("expiresIn", expiresIn);
      if (maxViews) {
        const mv = parseInt(maxViews, 10);
        if (mv >= MAX_VIEWS_MIN && mv <= MAX_VIEWS_MAX) formData.append("maxViews", String(mv));
      }
      if (requirePassword) formData.append("requirePassword", "true");

      const res = await fetchApi(API_PATH.SENDS_FILE, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(tApi(apiErrorToI18nKey(err?.error)));
        return;
      }

      const data = await res.json();
      const fullUrl = appUrl(data.url);
      setCreatedUrl(fullUrl);
      if (data.accessPassword) setCreatedAccessPassword(data.accessPassword);
      onCreated?.();
      toast.success(t("sendCreateSuccess"));
    } catch {
      toast.error(tApi("unknownError"));
    } finally {
      setCreating(false);
    }
  };

  const handleCreate = () => {
    if (tab === "text") return handleCreateText();
    return handleCreateFile();
  };

  const handleCopyUrl = async () => {
    if (!createdUrl) return;
    await navigator.clipboard.writeText(createdUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    if (selected.size > SEND_MAX_FILE_SIZE) {
      toast.error(tApi("sendFileTooLarge"));
      return;
    }
    setFile(selected);
  };

  const isValid =
    name.trim().length > 0 &&
    (tab === "text" ? text.length > 0 && text.length <= SEND_MAX_TEXT_LENGTH : !!file);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5" />
            {t("newSend")}
          </DialogTitle>
          <DialogDescription>{t("newSendDesc")}</DialogDescription>
        </DialogHeader>

        {createdUrl ? (
          <div className="space-y-3 rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
            <div className="space-y-2">
              <Label className="text-xs">{t("shareUrl")}</Label>
              <div className="flex items-center gap-2">
                <Input value={createdUrl} readOnly className="font-mono text-xs" />
                <Button variant="outline" size="icon" className="h-9 w-9" onClick={handleCopyUrl}>
                  {copied ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
            {createdAccessPassword && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                  <Label className="text-xs">{t("accessPasswordLabel")}</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Input value={createdAccessPassword} readOnly className="font-mono text-xs" />
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={async () => {
                      await navigator.clipboard.writeText(createdAccessPassword);
                      setPasswordCopied(true);
                      setTimeout(() => setPasswordCopied(false), 2000);
                    }}
                  >
                    {passwordCopied ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>{t("accessPasswordWarning")}</span>
                </div>
              </div>
            )}
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                resetForm();
              }}
            >
              {t("createAnother")}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="text" className="flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" />
                  {t("sendText")}
                </TabsTrigger>
                <TabsTrigger value="file" className="flex items-center gap-1.5">
                  <Paperclip className="h-3.5 w-3.5" />
                  {t("sendFile")}
                </TabsTrigger>
              </TabsList>

              {/* Name field (shared) */}
              <div className="space-y-2 pt-3">
                <Label className="text-xs">{t("sendName")}</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("sendNamePlaceholder")}
                  maxLength={SEND_NAME_MAX_LENGTH}
                />
              </div>

              <TabsContent value="text" className="space-y-3 mt-0">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">{t("sendContent")}</Label>
                    <span className="text-xs text-muted-foreground">
                      {text.length.toLocaleString()}/{SEND_MAX_TEXT_LENGTH.toLocaleString()}
                    </span>
                  </div>
                  <Textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={t("sendTextPlaceholder")}
                    rows={8}
                    className="font-mono text-sm resize-y"
                    maxLength={SEND_MAX_TEXT_LENGTH}
                  />
                </div>
              </TabsContent>

              <TabsContent value="file" className="space-y-3 mt-0">
                <div className="space-y-2">
                  <Label className="text-xs">{t("sendFile")}</Label>
                  {file ? (
                    <div className="flex items-center justify-between rounded-lg border bg-muted/20 p-3">
                      <div className="min-w-0">
                        <p className="text-sm truncate">{file.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatFileSize(file.size)}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setFile(null);
                          if (fileInputRef.current) fileInputRef.current.value = "";
                        }}
                      >
                        {t("remove")}
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                    >
                      <Upload className="h-8 w-8" />
                      <span className="text-sm">{t("sendDropzone")}</span>
                      <span className="text-xs">{t("sendMaxFileSize")}</span>
                    </button>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                </div>
              </TabsContent>
            </Tabs>

            {/* Expiry + Max views + Password */}
            <div className="space-y-3 rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-xs flex items-center gap-1.5">
                    <Lock className="h-3 w-3" />
                    {t("requirePassword")}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t("requirePasswordDesc")}
                  </p>
                </div>
                <Switch
                  checked={requirePassword}
                  onCheckedChange={setRequirePassword}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">{t("expiresInLabel")}</Label>
                <Select value={expiresIn} onValueChange={setExpiresIn}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_OPTIONS.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {t(`expiry_${opt}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs">{t("maxViewsLabel")}</Label>
                <Input
                  type="number"
                  min={MAX_VIEWS_MIN}
                  max={MAX_VIEWS_MAX}
                  placeholder={t("maxViewsPlaceholder")}
                  value={maxViews}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (!raw) { setMaxViews(""); return; }
                    const n = parseInt(raw, 10);
                    if (Number.isNaN(n) || n < MAX_VIEWS_MIN) { setMaxViews(""); return; }
                    setMaxViews(String(Math.min(n, MAX_VIEWS_MAX)));
                  }}
                />
              </div>
            </div>

            <DialogFooter className="border-t pt-4">
              <Button onClick={handleCreate} disabled={creating || !isValid}>
                {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t("create")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
