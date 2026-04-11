"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
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
import { Switch } from "@/components/ui/switch";
import {
  Loader2,
  Copy,
  Check,
  AlertTriangle,
  Trash2,
  Link as LinkIcon,
  ChevronDown,
  ChevronUp,
  Lock,
} from "lucide-react";
import { toast } from "sonner";
import { apiErrorToI18nKey } from "@/lib/api-error-codes";
import { API_PATH, apiPath } from "@/lib/constants";
import {
  SHARE_PERMISSION,
  SHARE_PERMISSION_VALUES,
  applySharePermissions,
} from "@/lib/constants/share-permission";
import { formatDateTime } from "@/lib/format-datetime";
import { fetchApi, appUrl } from "@/lib/url-helpers";
import { MAX_VIEWS_MIN, MAX_VIEWS_MAX } from "@/lib/validations";
import { isProtoKey } from "@/lib/safe-keys";

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
  teamPasswordEntryId?: string;
  /** Decrypted data to share (TOTP excluded by caller) */
  decryptedData?: Record<string, unknown>;
  /** Entry type (required for team entries) */
  entryType?: string;
  /** Team ID — when provided, sharing policy is checked */
  teamId?: string;
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

// Fields excluded from preview (metadata / internal-only)
const INTERNAL_FIELDS = new Set([
  "tags", "generatorSettings", "passwordHistory", "travelSafe", "totp",
  "isMarkdown", "entryType", "createdAt", "updatedAt",
  // overview-only derived fields (shouldn't appear in fullBlob, but defensive)
  "snippet", "urlHost", "lastFour", "accountNumberLast4", "idNumberLast4", "requireReprompt",
]);

/** Map data field names → Share.json i18n keys */
const FIELD_I18N_KEY: Record<string, string> = {
  title: "fieldTitle",
  username: "username", password: "password", url: "url", notes: "notes",
  content: "content",
  cardholderName: "cardholderName", cardNumber: "cardNumber", brand: "brand",
  expiryMonth: "expiry", expiryYear: "expiry", cvv: "cvv",
  fullName: "fullName", address: "address", phone: "phone", email: "email",
  dateOfBirth: "dateOfBirth", nationality: "nationality", idNumber: "idNumber",
  issueDate: "issueDate", expiryDate: "expiryDate",
  relyingPartyId: "relyingPartyId", relyingPartyName: "relyingPartyName",
  credentialId: "credentialId", creationDate: "creationDate", deviceInfo: "deviceInfo",
  bankName: "bankName", accountType: "accountType", accountHolderName: "accountHolderName",
  accountNumber: "accountNumber", routingNumber: "routingNumber",
  swiftBic: "swiftBic", iban: "iban", branchName: "branchName",
  softwareName: "softwareName", licenseKey: "licenseKey", version: "version",
  licensee: "licensee", purchaseDate: "purchaseDate", expirationDate: "expirationDate",
  privateKey: "privateKey", publicKey: "publicKey", keyType: "keyType",
  keySize: "keySize", fingerprint: "fingerprint",
  passphrase: "passphrase", comment: "comment",
  customFields: "customFields",
};

export function ShareDialog({
  open,
  onOpenChange,
  passwordEntryId,
  teamPasswordEntryId,
  decryptedData,
  entryType,
  teamId,
}: ShareDialogProps) {
  const t = useTranslations("Share");
  const tApi = useTranslations("ApiErrors");
  const locale = useLocale();
  const [expiresIn, setExpiresIn] = useState<string>("1d");
  const [maxViews, setMaxViews] = useState<string>("");
  const [permission, setPermission] = useState<string>(SHARE_PERMISSION.VIEW_ALL);
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
  const [requirePassword, setRequirePassword] = useState(false);
  const [createdAccessPassword, setCreatedAccessPassword] = useState<string | null>(null);
  const [passwordCopied, setPasswordCopied] = useState(false);
  const [sharingAllowed, setSharingAllowed] = useState(true);
  const [passwordRequired, setPasswordRequired] = useState(false);

  const entryParam = passwordEntryId
    ? `passwordEntryId=${passwordEntryId}`
    : `teamPasswordEntryId=${teamPasswordEntryId}`;

  const fetchLinks = useCallback(async () => {
    setLoadingLinks(true);
    try {
      const res = await fetchApi(`${API_PATH.SHARE_LINKS}?${entryParam}`);
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
      setPermission(SHARE_PERMISSION.VIEW_ALL);
      fetchLinks();
    }
  }, [open, fetchLinks]);

  useEffect(() => {
    if (!open || !teamId) return;
    fetchApi(apiPath.teamPolicy(teamId))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.allowSharing === false) setSharingAllowed(false);
        else setSharingAllowed(true);
        if (data && data.requireSharePassword === true) {
          setPasswordRequired(true);
          setRequirePassword(true);
        } else {
          setPasswordRequired(false);
        }
      })
      .catch(() => {});
  }, [open, teamId]);

  const fieldPreview = useMemo(() => {
    if (!decryptedData) return null;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { totp, ...safeData } = decryptedData as Record<string, unknown>;
    const allKeys = Object.keys(safeData).filter(
      (k) => !INTERNAL_FIELDS.has(k) && safeData[k] !== undefined && safeData[k] !== null,
    );

    const permissions =
      permission === SHARE_PERMISSION.VIEW_ALL ? [] : [permission];
    const filtered = applySharePermissions(safeData, permissions, entryType);
    const filteredKeys = new Set(Object.keys(filtered).filter((k) => !INTERNAL_FIELDS.has(k)));

    // Deduplicate expiryMonth/expiryYear → single "expiry"
    const toLabelKey = (field: string): string | null => {
      if (field === "expiryYear") return null; // merged into expiryMonth
      return FIELD_I18N_KEY[field] ?? field;
    };

    const visible: string[] = [];
    const hidden: string[] = [];
    const seen = new Set<string>();

    for (const key of allKeys) {
      const label = toLabelKey(key);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      if (filteredKeys.has(key) || (key === "expiryMonth" && filteredKeys.has("expiryYear"))) {
        visible.push(label);
      } else {
        hidden.push(label);
      }
    }

    return { visible, hidden };
  }, [decryptedData, permission, entryType]);

  const handleCreate = async () => {
    setCreating(true);
    let shareKeyForFragment: Uint8Array | undefined;
    try {
      const body: Record<string, unknown> = {
        expiresIn,
      };

      // Strip TOTP and undefined/null fields before sharing (F-21)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { totp, ...rawData } = (decryptedData ?? {}) as Record<string, unknown>;
      const safeData: Record<string, unknown> = Object.create(null);
      for (const [k, v] of Object.entries(rawData)) {
        if (v !== undefined && v !== null && !isProtoKey(k)) safeData[k] = v;
      }

      const permissions =
        permission === SHARE_PERMISSION.VIEW_ALL ? [] : [permission];
      if (permissions.length > 0) {
        body.permissions = permissions;
      }

      if (passwordEntryId) {
        body.passwordEntryId = passwordEntryId;
        body.data = safeData;
      } else {
        // Team entry: E2E — encrypt with random share key, reduced blob per permissions
        if (!decryptedData) {
          toast.error(t("createError"));
          return;
        }
        const filteredData = applySharePermissions(safeData, permissions, entryType);
        const encrypted = await encryptForShare(filteredData);
        body.teamPasswordEntryId = teamPasswordEntryId;
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
        if (mv >= MAX_VIEWS_MIN && mv <= MAX_VIEWS_MAX) body.maxViews = mv;
      }
      if (requirePassword) body.requirePassword = true;

      const res = await fetchApi(API_PATH.SHARE_LINKS, {
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
      let fullUrl = appUrl(data.url);
      if (shareKeyForFragment) {
        fullUrl += `#key=${base64urlEncode(shareKeyForFragment)}`;
        shareKeyForFragment.fill(0);
      }
      setCreatedUrl(fullUrl);
      if (data.accessPassword) setCreatedAccessPassword(data.accessPassword);
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
        const res = await fetchApi(url);
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
      const res = await fetchApi(apiPath.shareLinkById(id), { method: "DELETE" });
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
                setCreatedUrl(null);
                setCreatedAccessPassword(null);
                setPasswordCopied(false);
              }}
            >
              {t("createAnother")}
            </Button>
          </div>
        ) : !sharingAllowed ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <p className="text-sm text-destructive">
                {t("sharingDisabledByPolicy")}
              </p>
            </div>
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

            {/* Password protection */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-xs flex items-center gap-1.5">
                  <Lock className="h-3 w-3" />
                  {t("requirePassword")}
                </Label>
                <p className={`text-xs ${passwordRequired ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
                  {passwordRequired
                    ? t("requirePasswordPolicy")
                    : t("requirePasswordDesc")}
                </p>
              </div>
              <Switch
                checked={requirePassword}
                onCheckedChange={setRequirePassword}
                disabled={passwordRequired}
              />
            </div>

            {/* Permissions */}
            <div className="space-y-2">
              <Label className="text-xs">{t("permissionLabel")}</Label>
              <Select value={permission} onValueChange={setPermission}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SHARE_PERMISSION_VALUES.map((perm) => (
                    <SelectItem key={perm} value={perm}>
                      <span>{t(`permission_${perm}`)}</span>
                      <span className="ml-2 text-muted-foreground">
                        — {t(`permission_${perm}_desc`)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Field preview */}
            {fieldPreview && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t("previewTitle")}</Label>
                <div className="flex flex-wrap gap-1.5">
                  {fieldPreview.visible.map((label) => (
                    <span
                      key={label}
                      className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                    >
                      {t(label)}
                    </span>
                  ))}
                  {fieldPreview.hidden.map((label) => (
                    <span
                      key={label}
                      className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800 line-through dark:bg-red-900/40 dark:text-red-300"
                    >
                      {t(label)} ({t("previewHidden")})
                    </span>
                  ))}
                </div>
              </div>
            )}

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
                <div key={link.id} className="rounded-xl border bg-background/80 text-xs transition-colors hover:bg-accent/30 dark:hover:bg-accent/50">
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
