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
import { useFormDirty } from "@/hooks/use-form-dirty";
import { useBeforeUnloadGuard } from "@/hooks/use-before-unload-guard";
import { FormDirtyBadge } from "@/components/settings/form-dirty-badge";

export function TenantSessionPolicyCard() {
  const t = useTranslations("TenantAdmin");
  const tCommon = useTranslations("Common");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [unlimited, setUnlimited] = useState(true);
  const [maxSessions, setMaxSessions] = useState<string>("");
  const [idleTimeoutEnabled, setIdleTimeoutEnabled] = useState(false);
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState<string>("");
  const [vaultAutoLockEnabled, setVaultAutoLockEnabled] = useState(false);
  const [vaultAutoLockMinutes, setVaultAutoLockMinutes] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [initialPolicy, setInitialPolicy] = useState<Record<string, unknown> | null>(null);

  const currentPolicy = useMemo(() => ({
    unlimited,
    maxSessions,
    idleTimeoutEnabled,
    idleTimeoutMinutes,
    vaultAutoLockEnabled,
    vaultAutoLockMinutes,
  }), [unlimited, maxSessions, idleTimeoutEnabled, idleTimeoutMinutes, vaultAutoLockEnabled, vaultAutoLockMinutes]);

  const hasChanges = useFormDirty(currentPolicy, initialPolicy);
  useBeforeUnloadGuard(hasChanges);

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.TENANT_POLICY);
      if (res.ok) {
        const data = await res.json();
        const maxVal = data.maxConcurrentSessions;
        let unlimitedVal: boolean;
        let maxSessionsVal: string;
        if (maxVal === null || maxVal === undefined) {
          unlimitedVal = true;
          maxSessionsVal = "";
        } else {
          unlimitedVal = false;
          maxSessionsVal = String(maxVal);
        }
        setUnlimited(unlimitedVal);
        setMaxSessions(maxSessionsVal);

        const idleVal = data.sessionIdleTimeoutMinutes;
        let idleEnabledVal: boolean;
        let idleMinutesVal: string;
        if (idleVal === null || idleVal === undefined) {
          idleEnabledVal = false;
          idleMinutesVal = "";
        } else {
          idleEnabledVal = true;
          idleMinutesVal = String(idleVal);
        }
        setIdleTimeoutEnabled(idleEnabledVal);
        setIdleTimeoutMinutes(idleMinutesVal);

        const autoLockVal = data.vaultAutoLockMinutes;
        let autoLockEnabledVal: boolean;
        let autoLockMinutesVal: string;
        if (autoLockVal === null || autoLockVal === undefined) {
          autoLockEnabledVal = false;
          autoLockMinutesVal = "";
        } else {
          autoLockEnabledVal = true;
          autoLockMinutesVal = String(autoLockVal);
        }
        setVaultAutoLockEnabled(autoLockEnabledVal);
        setVaultAutoLockMinutes(autoLockMinutesVal);

        setInitialPolicy({
          unlimited: unlimitedVal,
          maxSessions: maxSessionsVal,
          idleTimeoutEnabled: idleEnabledVal,
          idleTimeoutMinutes: idleMinutesVal,
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
      if (!Number.isInteger(num) || num < 1) return t("sessionPolicyValidationMin");
      if (num > 100) return t("sessionPolicyValidationMax");
    }
    if (idleTimeoutEnabled) {
      const num = Number(idleTimeoutMinutes);
      if (!Number.isInteger(num) || num < 1) return t("idleTimeoutValidationMin");
      if (num > 1440) return t("idleTimeoutValidationMax");
    }
    if (vaultAutoLockEnabled) {
      const num = Number(vaultAutoLockMinutes);
      if (!Number.isInteger(num) || num < 1) return t("vaultAutoLockValidationMin");
      if (num > 1440) return t("vaultAutoLockValidationMax");
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
        sessionIdleTimeoutMinutes: idleTimeoutEnabled ? Number(idleTimeoutMinutes) : null,
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
        toast.error(t("sessionPolicySaveFailed"));
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
          <Label htmlFor="unlimited-toggle">{t("unlimited")}</Label>
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
              min={1}
              max={100}
              value={maxSessions}
              onChange={(e) => {
                const raw = e.target.value;
                if (!raw) { setMaxSessions(""); } else {
                  const n = parseInt(raw, 10);
                  if (Number.isNaN(n) || n < 1) { setMaxSessions(""); } else {
                    setMaxSessions(String(Math.min(n, 100)));
                  }
                }
                setError(null);
              }}
              placeholder="3"
            />
            <p className="text-xs text-muted-foreground">
              {t("maxConcurrentSessionsHelp")}
            </p>
          </div>
        )}

        <Separator />

        {/* Idle timeout */}
        <div className="flex items-center justify-between">
          <Label htmlFor="idle-timeout-toggle">{t("idleTimeoutEnabled")}</Label>
          <Switch
            id="idle-timeout-toggle"
            checked={idleTimeoutEnabled}
            onCheckedChange={(checked) => {
              setIdleTimeoutEnabled(checked);
              setError(null);
              if (!checked) setIdleTimeoutMinutes("");
            }}
          />
        </div>

        {idleTimeoutEnabled && (
          <div className="space-y-2">
            <Label htmlFor="idle-timeout">{t("idleTimeoutMinutes")}</Label>
            <Input
              id="idle-timeout"
              type="number"
              min={1}
              max={1440}
              value={idleTimeoutMinutes}
              onChange={(e) => {
                const raw = e.target.value;
                if (!raw) { setIdleTimeoutMinutes(""); } else {
                  const n = parseInt(raw, 10);
                  if (Number.isNaN(n) || n < 1) { setIdleTimeoutMinutes(""); } else {
                    setIdleTimeoutMinutes(String(Math.min(n, 1440)));
                  }
                }
                setError(null);
              }}
              placeholder="30"
            />
            <p className="text-xs text-muted-foreground">
              {t("idleTimeoutHelp")}
            </p>
          </div>
        )}

        <Separator />

        {/* Vault auto-lock timeout */}
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
              min={1}
              max={1440}
              value={vaultAutoLockMinutes}
              onChange={(e) => {
                const raw = e.target.value;
                if (!raw) { setVaultAutoLockMinutes(""); } else {
                  const n = parseInt(raw, 10);
                  if (Number.isNaN(n) || n < 1) { setVaultAutoLockMinutes(""); } else {
                    setVaultAutoLockMinutes(String(Math.min(n, 1440)));
                  }
                }
                setError(null);
              }}
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
