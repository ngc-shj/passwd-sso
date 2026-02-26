"use client";

import { useState, useEffect, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Copy,
  Check,
  AlertTriangle,
  Trash2,
  Link as LinkIcon,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { toast } from "sonner";
import { apiErrorToI18nKey } from "@/lib/api-error-codes";
import { API_PATH, apiPath } from "@/lib/constants";
import { formatDateTime } from "@/lib/format-datetime";

interface ShareLink {
  id: string;
  expiresAt: string;
  maxViews: number | null;
  viewCount: number;
  revokedAt: string | null;
  createdAt: string;
  isActive: boolean;
}

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  passwordEntryId?: string;
  orgPasswordEntryId?: string;
  /** Decrypted data to share (TOTP excluded by caller) */
  decryptedData?: Record<string, unknown>;
  /** Entry type (required for org entries) */
  entryType?: string;
}

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64urlEncode(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function encryptForShare(
  data: Record<string, unknown>
): Promise<{ ciphertext: string; iv: string; authTag: string; shareKey: Uint8Array }> {
  const shareKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));

  const key = await crypto.subtle.importKey(
    "raw",
    shareKey,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );

  // Web Crypto appends 16-byte auth tag to ciphertext
  const combined = new Uint8Array(encrypted);
  const ct = combined.slice(0, combined.length - 16);
  const tag = combined.slice(combined.length - 16);

  return {
    ciphertext: hexEncode(ct),
    iv: hexEncode(iv),
    authTag: hexEncode(tag),
    shareKey,
  };
}

const EXPIRY_OPTIONS = ["1h", "1d", "7d", "30d"] as const;

export function ShareDialog({
  open,
  onOpenChange,
  passwordEntryId,
  orgPasswordEntryId,
  decryptedData,
  entryType,
}: ShareDialogProps) {
  const t = useTranslations("Share");
  const tApi = useTranslations("ApiErrors");
  const locale = useLocale();
  const [expiresIn, setExpiresIn] = useState<string>("1d");
  const [maxViews, setMaxViews] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [accessLogs, setAccessLogs] = useState<
    { id: string; ip: string | null; userAgent: string | null; createdAt: string }[]
  >([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logNextCursor, setLogNextCursor] = useState<string | null>(null);

  const entryParam = passwordEntryId
    ? `passwordEntryId=${passwordEntryId}`
    : `orgPasswordEntryId=${orgPasswordEntryId}`;

  const fetchLinks = useCallback(async () => {
    setLoadingLinks(true);
    try {
      const res = await fetch(`${API_PATH.SHARE_LINKS}?${entryParam}`);
      if (res.ok) {
        const data = await res.json();
        setLinks(data.items);
      }
    } catch {
      // silently fail
    } finally {
      setLoadingLinks(false);
    }
  }, [entryParam]);

  useEffect(() => {
    if (open) {
      setCreatedUrl(null);
      fetchLinks();
    }
  }, [open, fetchLinks]);

  const handleCreate = async () => {
    setCreating(true);
    let shareKeyForFragment: Uint8Array | undefined;
    try {
      const body: Record<string, unknown> = {
        expiresIn,
      };

      // Strip TOTP before sharing (F-21)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { totp, ...safeData } = (decryptedData ?? {}) as Record<string, unknown>;

      if (passwordEntryId) {
        body.passwordEntryId = passwordEntryId;
        body.data = safeData;
      } else {
        // Team entry: E2E — encrypt with random share key
        if (!decryptedData) {
          toast.error(t("createError"));
          return;
        }
        const encrypted = await encryptForShare(safeData);
        body.orgPasswordEntryId = orgPasswordEntryId;
        body.encryptedShareData = {
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
        };
        body.entryType = entryType;
        shareKeyForFragment = encrypted.shareKey;
      }
      if (maxViews) {
        const mv = parseInt(maxViews, 10);
        if (mv >= 1 && mv <= 100) body.maxViews = mv;
      }

      const res = await fetch(API_PATH.SHARE_LINKS, {
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
      let fullUrl = `${window.location.origin}${data.url}`;
      if (shareKeyForFragment) {
        fullUrl += `#key=${base64urlEncode(shareKeyForFragment)}`;
        shareKeyForFragment.fill(0);
      }
      setCreatedUrl(fullUrl);
      fetchLinks();
      toast.success(t("createSuccess"));
    } catch {
      toast.error(t("createError"));
    } finally {
      shareKeyForFragment?.fill(0);
      setCreating(false);
    }
  };

  const handleCopyUrl = async () => {
    if (!createdUrl) return;
    await navigator.clipboard.writeText(createdUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const fetchAccessLogs = useCallback(
    async (shareId: string, cursor?: string | null) => {
      setLoadingLogs(true);
      try {
        const url = `${apiPath.shareLinkAccessLogs(shareId)}${cursor ? `?cursor=${cursor}` : ""}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          if (cursor) {
            setAccessLogs((prev) => [...prev, ...data.items]);
          } else {
            setAccessLogs(data.items);
          }
          setLogNextCursor(data.nextCursor);
        }
      } catch {
        // silently fail
      } finally {
        setLoadingLogs(false);
      }
    },
    []
  );

  const toggleAccessLogs = (shareId: string) => {
    if (expandedLogId === shareId) {
      setExpandedLogId(null);
      setAccessLogs([]);
      setLogNextCursor(null);
    } else {
      setExpandedLogId(shareId);
      fetchAccessLogs(shareId);
    }
  };

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    try {
      const res = await fetch(apiPath.shareLinkById(id), { method: "DELETE" });
      if (res.ok) {
        toast.success(t("revokeSuccess"));
        fetchLinks();
      } else {
        toast.error(t("revokeError"));
      }
    } catch {
      toast.error(t("revokeError"));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LinkIcon className="h-5 w-5" />
            {t("createShareLink")}
          </DialogTitle>
          <DialogDescription>{t("createShareLinkDesc")}</DialogDescription>
        </DialogHeader>

        {/* Warning for personal entries */}
        {passwordEntryId && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200/60 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-amber-700 dark:text-amber-400">
              {t("personalShareWarning")}
            </p>
          </div>
        )}

        {/* Created URL display */}
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
            <Button variant="outline" className="w-full" onClick={() => setCreatedUrl(null)}>
              {t("createAnother")}
            </Button>
          </div>
        ) : (
          <div className="space-y-4 rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
            {/* Expiry */}
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

            {/* Max views */}
            <div className="space-y-2">
              <Label className="text-xs">{t("maxViewsLabel")}</Label>
              <Input
                type="number"
                min={1}
                max={100}
                placeholder={t("maxViewsPlaceholder")}
                value={maxViews}
                onChange={(e) => setMaxViews(e.target.value)}
              />
            </div>

            <DialogFooter className="border-t pt-4">
              <Button onClick={handleCreate} disabled={creating}>
                {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t("create")}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Existing links */}
        {links.length > 0 && (
          <div className="space-y-3 border-t pt-4">
            <h3 className="text-sm font-medium tracking-tight">{t("existingLinks")}</h3>
            {loadingLinks ? (
              <div className="flex justify-center py-2">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : (
              <div className="space-y-2 rounded-xl border bg-card/80 p-2">
              {links.map((link) => (
                <div key={link.id} className="rounded-xl border bg-background/80 text-xs transition-colors hover:bg-accent">
                  <div className="flex items-center justify-between p-3">
                    <div className="space-y-1">
                      <p className="text-muted-foreground leading-none">
                        {formatDateTime(link.createdAt, locale)}
                      </p>
                      <p className="text-muted-foreground">
                        {link.maxViews
                          ? t("viewCount", {
                              current: link.viewCount,
                              max: link.maxViews,
                            })
                          : `${link.viewCount} ${t("views")}`}
                      </p>
                      {!link.isActive && (
                        <p className="inline-flex rounded-full bg-destructive/10 px-2 py-0.5 text-destructive font-medium">
                          {link.revokedAt ? t("revoked") : t("expired")}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {link.viewCount > 0 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => toggleAccessLogs(link.id)}
                        >
                          {expandedLogId === link.id ? (
                            <ChevronUp className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}
                      {link.isActive && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          onClick={() => handleRevoke(link.id)}
                          disabled={revokingId === link.id}
                        >
                          {revokingId === link.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                  {/* Access logs */}
                  {expandedLogId === link.id && (
                    <div className="border-t px-3 py-2 space-y-1.5">
                      <p className="font-medium text-muted-foreground">
                        {t("accessLogs")}
                      </p>
                      {loadingLogs && accessLogs.length === 0 ? (
                        <div className="flex justify-center py-2">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        </div>
                      ) : accessLogs.length === 0 ? (
                        <p className="text-muted-foreground py-1">
                          {t("noAccessLogs")}
                        </p>
                      ) : (
                        <>
                          <div className="space-y-1">
                            {accessLogs.map((log) => (
                              <div
                                key={log.id}
                                className="flex items-center justify-between text-muted-foreground py-0.5"
                              >
                                <span>
                                  {formatDateTime(log.createdAt, locale)}
                                </span>
                                <span className="font-mono">
                                  {log.ip ?? "-"}
                                </span>
                              </div>
                            ))}
                          </div>
                          {logNextCursor && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="w-full h-6 text-xs"
                              onClick={() =>
                                fetchAccessLogs(link.id, logNextCursor)
                              }
                              disabled={loadingLogs}
                            >
                              {loadingLogs ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                t("loadMoreLogs")
                              )}
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
