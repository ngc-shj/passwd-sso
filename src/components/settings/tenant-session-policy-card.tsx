"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/section-card-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import {
  MAX_CONCURRENT_SESSIONS_MIN,
  MAX_CONCURRENT_SESSIONS_MAX,
  SESSION_IDLE_TIMEOUT_MIN,
  SESSION_IDLE_TIMEOUT_MAX,
  SESSION_ABSOLUTE_TIMEOUT_MIN,
  SESSION_ABSOLUTE_TIMEOUT_MAX,
  EXTENSION_TOKEN_IDLE_TIMEOUT_MIN,
  EXTENSION_TOKEN_IDLE_TIMEOUT_MAX,
  EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MIN,
  EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MAX,
  VAULT_AUTO_LOCK_MIN,
  VAULT_AUTO_LOCK_MAX,
} from "@/lib/validations";
import { useFormDirty } from "@/hooks/use-form-dirty";
import { useBeforeUnloadGuard } from "@/hooks/use-before-unload-guard";
import { FormDirtyBadge } from "@/components/settings/form-dirty-badge";

// Enforce ONLY the max during typing. If we also enforced min here, the user
// would never be able to type "15" (the "1" keystroke would be rejected first).
// min is enforced on blur + hard-stopped in validate() before save.
function parseIntMaxOnly(raw: string, max: number): string {
  if (!raw) return "";
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return "";
  return String(Math.min(n, max));
}

// On blur, clamp values below the minimum up to the minimum. Preserves the
// user's intent when they wanted a short value without letting them save
// something below the server-side floor.
function clampToMin(raw: string, min: number): string {
  if (!raw) return "";
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return "";
  return n < min ? String(min) : raw;
}

export function TenantSessionPolicyCard() {
  const t = useTranslations("TenantAdmin");
  const tCommon = useTranslations("Common");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Concurrent session limit (existing behavior preserved)
  const [unlimited, setUnlimited] = useState(true);
  const [maxSessions, setMaxSessions] = useState<string>("");

  // Web session timeouts (required, non-null per ASVS V7.3.1/V7.3.3)
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState<string>("");
  const [absoluteTimeoutMinutes, setAbsoluteTimeoutMinutes] = useState<string>("");

  // Browser extension token timeouts (required)
  const [extensionIdleMinutes, setExtensionIdleMinutes] = useState<string>("");
  const [extensionAbsoluteMinutes, setExtensionAbsoluteMinutes] = useState<string>("");

  // Vault auto-lock (existing)
  const [vaultAutoLockEnabled, setVaultAutoLockEnabled] = useState(false);
  const [vaultAutoLockMinutes, setVaultAutoLockMinutes] = useState<string>("");

  const [error, setError] = useState<string | null>(null);
  const [initialPolicy, setInitialPolicy] = useState<Record<string, unknown> | null>(null);

  const currentPolicy = useMemo(() => ({
    unlimited,
    maxSessions,
    idleTimeoutMinutes,
    absoluteTimeoutMinutes,
    extensionIdleMinutes,
    extensionAbsoluteMinutes,
    vaultAutoLockEnabled,
    vaultAutoLockMinutes,
  }), [unlimited, maxSessions, idleTimeoutMinutes, absoluteTimeoutMinutes, extensionIdleMinutes, extensionAbsoluteMinutes, vaultAutoLockEnabled, vaultAutoLockMinutes]);

  const hasChanges = useFormDirty(currentPolicy, initialPolicy);
  useBeforeUnloadGuard(hasChanges);

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.TENANT_POLICY);
      if (res.ok) {
        const data = await res.json();

        const maxVal = data.maxConcurrentSessions;
        const unlimitedVal = maxVal === null || maxVal === undefined;
        const maxSessionsVal = unlimitedVal ? "" : String(maxVal);
        setUnlimited(unlimitedVal);
        setMaxSessions(maxSessionsVal);

        const idleVal = String(data.sessionIdleTimeoutMinutes ?? 480);
        const absVal = String(data.sessionAbsoluteTimeoutMinutes ?? 43200);
        const extIdleVal = String(data.extensionTokenIdleTimeoutMinutes ?? 10080);
        const extAbsVal = String(data.extensionTokenAbsoluteTimeoutMinutes ?? 43200);
        setIdleTimeoutMinutes(idleVal);
        setAbsoluteTimeoutMinutes(absVal);
        setExtensionIdleMinutes(extIdleVal);
        setExtensionAbsoluteMinutes(extAbsVal);

        const autoLockVal = data.vaultAutoLockMinutes;
        const autoLockEnabledVal = !(autoLockVal === null || autoLockVal === undefined);
        const autoLockMinutesVal = autoLockEnabledVal ? String(autoLockVal) : "";
        setVaultAutoLockEnabled(autoLockEnabledVal);
        setVaultAutoLockMinutes(autoLockMinutesVal);

        setInitialPolicy({
          unlimited: unlimitedVal,
          maxSessions: maxSessionsVal,
          idleTimeoutMinutes: idleVal,
          absoluteTimeoutMinutes: absVal,
          extensionIdleMinutes: extIdleVal,
          extensionAbsoluteMinutes: extAbsVal,
          vaultAutoLockEnabled: autoLockEnabledVal,
          vaultAutoLockMinutes: autoLockMinutesVal,
        });
      } else {
        toast.error(t("sessionPolicyLoadFailed"));
      }
    } catch {
      toast.error(t("sessionPolicyLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchPolicy();
  }, [fetchPolicy]);

  const validate = (): string | null => {
    if (!unlimited) {
      const num = Number(maxSessions);
      if (!Number.isInteger(num) || num < MAX_CONCURRENT_SESSIONS_MIN) return t("sessionPolicyValidationMin");
      if (num > MAX_CONCURRENT_SESSIONS_MAX) return t("sessionPolicyValidationMax");
    }
    const idleNum = Number(idleTimeoutMinutes);
    if (!Number.isInteger(idleNum) || idleNum < SESSION_IDLE_TIMEOUT_MIN) return t("idleTimeoutValidationMin");
    if (idleNum > SESSION_IDLE_TIMEOUT_MAX) return t("idleTimeoutValidationMax");

    const absNum = Number(absoluteTimeoutMinutes);
    if (!Number.isInteger(absNum) || absNum < SESSION_ABSOLUTE_TIMEOUT_MIN) return t("absoluteTimeoutValidationMin");
    if (absNum > SESSION_ABSOLUTE_TIMEOUT_MAX) return t("absoluteTimeoutValidationMax");

    const extIdleNum = Number(extensionIdleMinutes);
    if (!Number.isInteger(extIdleNum) || extIdleNum < EXTENSION_TOKEN_IDLE_TIMEOUT_MIN) return t("extensionIdleValidationMin");
    if (extIdleNum > EXTENSION_TOKEN_IDLE_TIMEOUT_MAX) return t("extensionIdleValidationMax");

    const extAbsNum = Number(extensionAbsoluteMinutes);
    if (!Number.isInteger(extAbsNum) || extAbsNum < EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MIN) return t("extensionAbsoluteValidationMin");
    if (extAbsNum > EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MAX) return t("extensionAbsoluteValidationMax");

    if (vaultAutoLockEnabled) {
      const num = Number(vaultAutoLockMinutes);
      if (!Number.isInteger(num) || num < VAULT_AUTO_LOCK_MIN) return t("vaultAutoLockValidationMin");
      if (num > VAULT_AUTO_LOCK_MAX) return t("vaultAutoLockValidationMax");
      // Cross-field: vault_auto_lock must not exceed the idle timeouts.
      // Catch it client-side so the user sees the exact rule rather than
      // a generic "failed to update" after a round-trip.
      const resolvedIdleCap = Math.min(idleNum, extIdleNum);
      if (num > resolvedIdleCap) {
        return t("vaultAutoLockExceedsIdleCap", { n: String(resolvedIdleCap) });
      }
    }
    return null;
  };

  const handleSave = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const body = {
        maxConcurrentSessions: unlimited ? null : Number(maxSessions),
        sessionIdleTimeoutMinutes: Number(idleTimeoutMinutes),
        sessionAbsoluteTimeoutMinutes: Number(absoluteTimeoutMinutes),
        extensionTokenIdleTimeoutMinutes: Number(extensionIdleMinutes),
        extensionTokenAbsoluteTimeoutMinutes: Number(extensionAbsoluteMinutes),
        vaultAutoLockMinutes: vaultAutoLockEnabled ? Number(vaultAutoLockMinutes) : null,
      };
      const res = await fetchApi(API_PATH.TENANT_POLICY, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(t("sessionPolicySaved"));
        setInitialPolicy({ ...currentPolicy });
      } else {
        // Surface the server-side validation message so cross-field
        // errors (e.g. "vaultAutoLockMinutes (60) must be <= ...") are
        // visible instead of a generic "failed to update".
        let detail: string | null = null;
        try {
          const data = await res.json();
          if (typeof data?.message === "string") {
            detail = data.message;
          }
        } catch {
          // Response was not JSON; fall back to the generic message.
        }
        setError(detail ?? t("sessionPolicySaveFailed"));
        toast.error(detail ?? t("sessionPolicySaveFailed"));
      }
    } catch {
      toast.error(t("sessionPolicySaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <SectionCardHeader icon={Clock} title={t("sessionPolicyTitle")} description={t("sessionPolicyDescription")} />
      <CardContent className="space-y-4">
        {/* Concurrent session limit */}
        <div className="flex items-center justify-between">
          <Label htmlFor="unlimited-toggle" className="flex-1 pr-4">{t("concurrentSessionsUnlimited")}</Label>
          <Switch
            id="unlimited-toggle"
            checked={unlimited}
            onCheckedChange={(checked) => {
              setUnlimited(checked);
              setError(null);
              if (checked) setMaxSessions("");
            }}
          />
        </div>

        {!unlimited && (
          <div className="space-y-2">
            <Label htmlFor="max-sessions">{t("maxConcurrentSessions")}</Label>
            <Input
              id="max-sessions"
              type="number"
              min={MAX_CONCURRENT_SESSIONS_MIN}
              max={MAX_CONCURRENT_SESSIONS_MAX}
              value={maxSessions}
              onChange={(e) => {
                setMaxSessions(parseIntMaxOnly(e.target.value, MAX_CONCURRENT_SESSIONS_MAX));
                setError(null);
              }}
              onBlur={(e) => setMaxSessions(clampToMin(e.target.value, MAX_CONCURRENT_SESSIONS_MIN))}
              placeholder="3"
            />
            <p className="text-xs text-muted-foreground">
              {t("maxConcurrentSessionsHelp")}
            </p>
          </div>
        )}

        <Separator />

        {/* Web session idle timeout */}
        <div className="space-y-2">
          <Label htmlFor="idle-timeout">{t("idleTimeoutMinutes")}</Label>
          <Input
            id="idle-timeout"
            type="number"
            min={SESSION_IDLE_TIMEOUT_MIN}
            max={SESSION_IDLE_TIMEOUT_MAX}
            value={idleTimeoutMinutes}
            onChange={(e) => {
              setIdleTimeoutMinutes(parseIntMaxOnly(e.target.value, SESSION_IDLE_TIMEOUT_MAX));
              setError(null);
            }}
            onBlur={(e) => setIdleTimeoutMinutes(clampToMin(e.target.value, SESSION_IDLE_TIMEOUT_MIN))}
            placeholder="480"
          />
          <p className="text-xs text-muted-foreground">
            {t("idleTimeoutHelp")}
          </p>
        </div>

        {/* Web session absolute timeout */}
        <div className="space-y-2">
          <Label htmlFor="absolute-timeout">{t("absoluteTimeoutMinutes")}</Label>
          <Input
            id="absolute-timeout"
            type="number"
            min={SESSION_ABSOLUTE_TIMEOUT_MIN}
            max={SESSION_ABSOLUTE_TIMEOUT_MAX}
            value={absoluteTimeoutMinutes}
            onChange={(e) => {
              setAbsoluteTimeoutMinutes(parseIntMaxOnly(e.target.value, SESSION_ABSOLUTE_TIMEOUT_MAX));
              setError(null);
            }}
            onBlur={(e) => setAbsoluteTimeoutMinutes(clampToMin(e.target.value, SESSION_ABSOLUTE_TIMEOUT_MIN))}
            placeholder="43200"
          />
          <p className="text-xs text-muted-foreground">
            {t("absoluteTimeoutHelp")}
          </p>
        </div>

        <Separator />

        {/* Browser extension idle */}
        <div className="space-y-2">
          <Label htmlFor="extension-idle">{t("extensionIdleMinutes")}</Label>
          <Input
            id="extension-idle"
            type="number"
            min={EXTENSION_TOKEN_IDLE_TIMEOUT_MIN}
            max={EXTENSION_TOKEN_IDLE_TIMEOUT_MAX}
            value={extensionIdleMinutes}
            onChange={(e) => {
              setExtensionIdleMinutes(parseIntMaxOnly(e.target.value, EXTENSION_TOKEN_IDLE_TIMEOUT_MAX));
              setError(null);
            }}
            onBlur={(e) => setExtensionIdleMinutes(clampToMin(e.target.value, EXTENSION_TOKEN_IDLE_TIMEOUT_MIN))}
            placeholder="10080"
          />
          <p className="text-xs text-muted-foreground">
            {t("extensionIdleHelp")}
          </p>
        </div>

        {/* Browser extension absolute */}
        <div className="space-y-2">
          <Label htmlFor="extension-absolute">{t("extensionAbsoluteMinutes")}</Label>
          <Input
            id="extension-absolute"
            type="number"
            min={EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MIN}
            max={EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MAX}
            value={extensionAbsoluteMinutes}
            onChange={(e) => {
              setExtensionAbsoluteMinutes(parseIntMaxOnly(e.target.value, EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MAX));
              setError(null);
            }}
            onBlur={(e) => setExtensionAbsoluteMinutes(clampToMin(e.target.value, EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MIN))}
            placeholder="43200"
          />
          <p className="text-xs text-muted-foreground">
            {t("extensionAbsoluteHelp")}
          </p>
        </div>

        <Separator />

        {/* Vault auto-lock timeout (existing) */}
        <div className="flex items-center justify-between">
          <Label htmlFor="vault-auto-lock-toggle">{t("vaultAutoLockEnabled")}</Label>
          <Switch
            id="vault-auto-lock-toggle"
            checked={vaultAutoLockEnabled}
            onCheckedChange={(checked) => {
              setVaultAutoLockEnabled(checked);
              setError(null);
              if (!checked) setVaultAutoLockMinutes("");
            }}
          />
        </div>

        {vaultAutoLockEnabled && (
          <div className="space-y-2">
            <Label htmlFor="vault-auto-lock">{t("vaultAutoLockMinutes")}</Label>
            <Input
              id="vault-auto-lock"
              type="number"
              min={VAULT_AUTO_LOCK_MIN}
              max={VAULT_AUTO_LOCK_MAX}
              value={vaultAutoLockMinutes}
              onChange={(e) => {
                setVaultAutoLockMinutes(parseIntMaxOnly(e.target.value, VAULT_AUTO_LOCK_MAX));
                setError(null);
              }}
              onBlur={(e) => setVaultAutoLockMinutes(clampToMin(e.target.value, VAULT_AUTO_LOCK_MIN))}
              placeholder="15"
            />
            <p className="text-xs text-muted-foreground">
              {t("vaultAutoLockHelp")}
            </p>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center justify-between">
          <FormDirtyBadge
            hasChanges={hasChanges}
            unsavedLabel={tCommon("statusUnsaved")}
            savedLabel={tCommon("statusSaved")}
          />
          <Button onClick={handleSave} disabled={saving || !hasChanges}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("sessionPolicySave")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
