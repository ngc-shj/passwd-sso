"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton } from "@/components/passwords/copy-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ChevronDown, Loader2, Plus, Key } from "lucide-react";
import { toast } from "sonner";
import { fetchApi } from "@/lib/url-helpers";
import { NAME_MAX_LENGTH } from "@/lib/validations";
import { formatDate } from "@/lib/format-datetime";
import { API_KEY_SCOPE, API_KEY_SCOPES, MAX_API_KEYS_PER_USER, type ApiKeyScope } from "@/lib/constants/api-key";

interface ApiKeyEntry {
  id: string;
  prefix: string;
  name: string;
  scopes: string[];
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

const SCOPE_I18N_KEYS: Record<ApiKeyScope, string> = {
  [API_KEY_SCOPE.PASSWORDS_READ]: "scopePasswordsRead",
  [API_KEY_SCOPE.PASSWORDS_WRITE]: "scopePasswordsWrite",
  [API_KEY_SCOPE.TAGS_READ]: "scopeTagsRead",
  [API_KEY_SCOPE.VAULT_STATUS]: "scopeVaultStatus",
};

const EXPIRY_OPTIONS = [
  { value: "30", key: "expiry30" },
  { value: "90", key: "expiry90" },
  { value: "180", key: "expiry180" },
  { value: "365", key: "expiry365" },
] as const;

export function ApiKeyManager() {
  const t = useTranslations("ApiKey");
  const locale = useLocale();
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<Set<ApiKeyScope>>(
    new Set([API_KEY_SCOPE.PASSWORDS_READ]),
  );
  const [expiryDays, setExpiryDays] = useState("90");

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetchApi("/api/api-keys");
      if (res.ok) {
        setKeys(await res.json());
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleScopeToggle = (scope: ApiKeyScope, checked: boolean) => {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(scope);
      } else {
        next.delete(scope);
      }
      return next;
    });
  };

  const handleCreate = async () => {
    if (!name.trim() || selectedScopes.size === 0) return;

    setCreating(true);
    try {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + parseInt(expiryDays, 10));

      const res = await fetchApi("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          scope: [...selectedScopes],
          expiresAt: expiresAt.toISOString(),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setNewToken(data.token);
        setName("");
        setSelectedScopes(new Set([API_KEY_SCOPE.PASSWORDS_READ]));
        setExpiryDays("90");
        toast.success(t("created"));
        fetchKeys();
      } else {
        const err = await res.json().catch(() => ({}));
        if (err.error === "API_KEY_LIMIT_EXCEEDED") {
          toast.error(t("limitExceeded", { max: MAX_API_KEYS_PER_USER }));
        } else if (res.status === 400) {
          toast.error(t("validationError"));
        } else {
          toast.error(t("createError"));
        }
      }
    } catch {
      toast.error(t("createError"));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (keyId: string) => {
    try {
      const res = await fetchApi(`/api/api-keys/${keyId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success(t("revoked_toast"));
        fetchKeys();
      } else {
        toast.error(t("revokeError"));
      }
    } catch {
      toast.error(t("revokeError"));
    }
  };

  const getStatus = (key: ApiKeyEntry) => {
    if (key.revokedAt) return "revoked";
    if (new Date(key.expiresAt) < new Date()) return "expired";
    return "active";
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Key className="h-5 w-5" />
          <CardTitle>{t("title")}</CardTitle>
        </div>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">

      {/* Create Key Form */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t("createKey")}</h3>
        <div className="space-y-2">
          <Label>{t("name")}</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("namePlaceholder")}
            maxLength={NAME_MAX_LENGTH}
          />
        </div>
        <div className="space-y-2">
          <Label>{t("scopes")}</Label>
          <div className="grid grid-cols-2 gap-2">
            {API_KEY_SCOPES.map((scope) => (
              <label
                key={scope}
                className="flex items-center gap-2 text-sm cursor-pointer"
              >
                <Checkbox
                  checked={selectedScopes.has(scope)}
                  onCheckedChange={(checked) =>
                    handleScopeToggle(scope, !!checked)
                  }
                />
                {t(SCOPE_I18N_KEYS[scope])}
              </label>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <Label>{t("expiry")}</Label>
          <Select value={expiryDays} onValueChange={setExpiryDays}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPIRY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {t(opt.key)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          onClick={handleCreate}
          disabled={creating || !name.trim() || selectedScopes.size === 0}
          size="sm"
        >
          {creating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {t("createKey")}
        </Button>
      </section>

      {/* Newly created token (shown once) */}
      {newToken && (
        <section className="border rounded-md p-4 bg-muted/50 space-y-2">
          <p className="text-sm font-medium">{t("tokenReady")}</p>
          <div className="flex items-center gap-2">
            <Input value={newToken} readOnly className="font-mono text-xs" />
            <CopyButton getValue={() => newToken} />
          </div>
          <p className="text-xs text-muted-foreground">{t("tokenOnce")}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setNewToken(null)}
          >
            OK
          </Button>
        </section>
      )}

      {/* Key List */}
      <KeyList
        keys={keys}
        loading={loading}
        locale={locale}
        t={t}
        getStatus={getStatus}
        onRevoke={handleRevoke}
      />
      </CardContent>
    </Card>
  );
}

// ─── Sub-components ──────────────────────────────────────────

type KeyStatus = "active" | "expired" | "revoked";

function KeyList({
  keys,
  loading,
  locale,
  t,
  getStatus,
  onRevoke,
}: {
  keys: ApiKeyEntry[];
  loading: boolean;
  locale: string;
  t: (key: string, values?: Record<string, string>) => string;
  getStatus: (key: ApiKeyEntry) => KeyStatus;
  onRevoke: (id: string) => void;
}) {
  const [showInactive, setShowInactive] = useState(false);

  const activeKeys = keys.filter((k) => getStatus(k) === "active");
  const inactiveKeys = keys.filter((k) => getStatus(k) !== "active");

  return (
    <>
      <Separator />
      <section className="space-y-3">
      <h3 className="text-sm font-medium">{t("title")}</h3>
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noKeys")}</p>
      ) : (
        <div className="space-y-3">
          {activeKeys.length === 0 && inactiveKeys.length > 0 && (
            <p className="text-sm text-muted-foreground">{t("noActiveKeys")}</p>
          )}
          {activeKeys.map((key) => (
            <KeyRow
              key={key.id}
              entry={key}
              status="active"
              locale={locale}
              t={t}
              onRevoke={onRevoke}
            />
          ))}
          {inactiveKeys.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowInactive((v) => !v)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${showInactive ? "rotate-0" : "-rotate-90"}`}
                />
                {t("inactiveKeys", { count: String(inactiveKeys.length) })}
              </button>
              {showInactive && (
                <div className="mt-2 space-y-3">
                  {inactiveKeys.map((key) => (
                    <KeyRow
                      key={key.id}
                      entry={key}
                      status={getStatus(key)}
                      locale={locale}
                      t={t}
                      onRevoke={onRevoke}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      </section>
    </>
  );
}

function KeyRow({
  entry,
  status,
  locale,
  t,
  onRevoke,
}: {
  entry: ApiKeyEntry;
  status: KeyStatus;
  locale: string;
  t: (key: string, values?: Record<string, string>) => string;
  onRevoke: (id: string) => void;
}) {
  return (
    <div className="flex items-center justify-between border rounded-md p-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{entry.name}</span>
          <code className="text-xs text-muted-foreground">
            {entry.prefix}...
          </code>
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${
              status === "active"
                ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                : status === "expired"
                  ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
                  : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
            }`}
          >
            {t(status)}
          </span>
        </div>
        <div className="text-xs text-muted-foreground space-x-3">
          <span>
            {entry.scopes
              .map((s) => t(SCOPE_I18N_KEYS[s as ApiKeyScope] ?? s))
              .join(", ")}
          </span>
          <span>
            {entry.lastUsedAt
              ? t("lastUsed", { date: formatDate(entry.lastUsedAt, locale) })
              : t("neverUsed")}
          </span>
          <span>
            {t("expiresAt", { date: formatDate(entry.expiresAt, locale) })}
          </span>
        </div>
      </div>
      {status === "active" && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm">
              {t("revoke")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("revokeConfirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("revokeConfirmDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={() => onRevoke(entry.id)}>
                {t("revoke")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
