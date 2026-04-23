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
import { useFormDirty } from "@/hooks/form/use-form-dirty";
import { useBeforeUnloadGuard } from "@/hooks/form/use-before-unload-guard";
import { FormDirtyBadge } from "@/components/settings/form-dirty-badge";

import { bindRangeInput } from "@/lib/input-range";

export function TenantSessionPolicyCard() {
  const t = useTranslations("TenantAdmin");
  const tCommon = useTranslations("Common");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Concurrent session limit (existing behavior preserved)
  const [unlimited, setUnlimited] = useState(true);
  const [maxSessions, setMaxSessions] = useState<string>("");

  // Web session timeouts (required, non-null per ASVS 5.0 V7.3.1/V7.3.2)
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
    // Helper: runs min/max check on a per-field basis and returns the
    // localized error message (or null). MIN/MAX are passed via i18n
    // interpolation so the copy stays in sync with the constants.
    type FieldSpec = {
      raw: string;
      min: number;
      max: number;
      minKey: string;
      maxKey: string;
    };
    const checkRange = (spec: FieldSpec): { error: string | null; num: number } => {
      const n = Number(spec.raw);
      if (!Number.isInteger(n) || n < spec.min) {
        return { error: t(spec.minKey, { min: spec.min }), num: NaN };
      }
      if (n > spec.max) {
        return { error: t(spec.maxKey, { max: spec.max }), num: NaN };
      }
      return { error: null, num: n };
    };

    if (!unlimited) {
      const r = checkRange({
        raw: maxSessions,
        min: MAX_CONCURRENT_SESSIONS_MIN,
        max: MAX_CONCURRENT_SESSIONS_MAX,
        minKey: "sessionPolicyValidationMin",
        maxKey: "sessionPolicyValidationMax",
      });
      if (r.error) return r.error;
    }

    const idle = checkRange({
      raw: idleTimeoutMinutes,
      min: SESSION_IDLE_TIMEOUT_MIN,
      max: SESSION_IDLE_TIMEOUT_MAX,
      minKey: "idleTimeoutValidationMin",
      maxKey: "idleTimeoutValidationMax",
    });
    if (idle.error) return idle.error;

    const abs = checkRange({
      raw: absoluteTimeoutMinutes,
      min: SESSION_ABSOLUTE_TIMEOUT_MIN,
      max: SESSION_ABSOLUTE_TIMEOUT_MAX,
      minKey: "absoluteTimeoutValidationMin",
      maxKey: "absoluteTimeoutValidationMax",
    });
    if (abs.error) return abs.error;

    const extIdle = checkRange({
      raw: extensionIdleMinutes,
      min: EXTENSION_TOKEN_IDLE_TIMEOUT_MIN,
      max: EXTENSION_TOKEN_IDLE_TIMEOUT_MAX,
      minKey: "extensionIdleValidationMin",
      maxKey: "extensionIdleValidationMax",
    });
    if (extIdle.error) return extIdle.error;

    const extAbs = checkRange({
      raw: extensionAbsoluteMinutes,
      min: EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MIN,
      max: EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MAX,
      minKey: "extensionAbsoluteValidationMin",
      maxKey: "extensionAbsoluteValidationMax",
    });
    if (extAbs.error) return extAbs.error;

    if (vaultAutoLockEnabled) {
      const vault = checkRange({
        raw: vaultAutoLockMinutes,
        min: VAULT_AUTO_LOCK_MIN,
        max: VAULT_AUTO_LOCK_MAX,
        minKey: "vaultAutoLockValidationMin",
        maxKey: "vaultAutoLockValidationMax",
      });
      if (vault.error) return vault.error;
      // Cross-field: vault_auto_lock must not exceed the idle timeouts.
      const resolvedIdleCap = Math.min(idle.num, extIdle.num);
      if (vault.num > resolvedIdleCap) {
        return t("vaultAutoLockExceedsIdleCap", { n: resolvedIdleCap });
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
              {...bindRangeInput(setMaxSessions, {
                min: MAX_CONCURRENT_SESSIONS_MIN,
                max: MAX_CONCURRENT_SESSIONS_MAX,
                onEdit: () => setError(null),
              })}
              placeholder="3"
            />
            <p className="text-xs text-muted-foreground">
              {t("maxConcurrentSessionsHelp", { min: MAX_CONCURRENT_SESSIONS_MIN, max: MAX_CONCURRENT_SESSIONS_MAX })}
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
            {...bindRangeInput(setIdleTimeoutMinutes, {
              min: SESSION_IDLE_TIMEOUT_MIN,
              max: SESSION_IDLE_TIMEOUT_MAX,
              onEdit: () => setError(null),
            })}
            placeholder="480"
          />
          <p className="text-xs text-muted-foreground">
            {t("idleTimeoutHelp", { min: SESSION_IDLE_TIMEOUT_MIN, max: SESSION_IDLE_TIMEOUT_MAX })}
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
            {...bindRangeInput(setAbsoluteTimeoutMinutes, {
              min: SESSION_ABSOLUTE_TIMEOUT_MIN,
              max: SESSION_ABSOLUTE_TIMEOUT_MAX,
              onEdit: () => setError(null),
            })}
            placeholder="43200"
          />
          <p className="text-xs text-muted-foreground">
            {t("absoluteTimeoutHelp", { min: SESSION_ABSOLUTE_TIMEOUT_MIN, max: SESSION_ABSOLUTE_TIMEOUT_MAX })}
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
            {...bindRangeInput(setExtensionIdleMinutes, {
              min: EXTENSION_TOKEN_IDLE_TIMEOUT_MIN,
              max: EXTENSION_TOKEN_IDLE_TIMEOUT_MAX,
              onEdit: () => setError(null),
            })}
            placeholder="10080"
          />
          <p className="text-xs text-muted-foreground">
            {t("extensionIdleHelp", { min: EXTENSION_TOKEN_IDLE_TIMEOUT_MIN, max: EXTENSION_TOKEN_IDLE_TIMEOUT_MAX })}
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
            {...bindRangeInput(setExtensionAbsoluteMinutes, {
              min: EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MIN,
              max: EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MAX,
              onEdit: () => setError(null),
            })}
            placeholder="43200"
          />
          <p className="text-xs text-muted-foreground">
            {t("extensionAbsoluteHelp", { min: EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MIN, max: EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MAX })}
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
              {...bindRangeInput(setVaultAutoLockMinutes, {
                min: VAULT_AUTO_LOCK_MIN,
                max: VAULT_AUTO_LOCK_MAX,
                onEdit: () => setError(null),
              })}
              placeholder="15"
            />
            <p className="text-xs text-muted-foreground">
              {t("vaultAutoLockHelp", { min: VAULT_AUTO_LOCK_MIN, max: VAULT_AUTO_LOCK_MAX })}
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
