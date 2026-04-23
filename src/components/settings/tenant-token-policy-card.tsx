"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Key, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/section-card-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import {
  SA_TOKEN_MAX_EXPIRY_MIN,
  SA_TOKEN_MAX_EXPIRY_MAX,
  JIT_TOKEN_TTL_MIN,
  JIT_TOKEN_TTL_MAX,
} from "@/lib/validations";
import { useFormDirty } from "@/hooks/form/use-form-dirty";
import { useBeforeUnloadGuard } from "@/hooks/form/use-before-unload-guard";
import { bindRangeInput } from "@/lib/ui/input-range";
import { FormDirtyBadge } from "@/components/settings/form-dirty-badge";

export function TenantTokenPolicyCard() {
  const t = useTranslations("TenantAdmin");
  const tCommon = useTranslations("Common");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialPolicy, setInitialPolicy] = useState<Record<string, unknown> | null>(null);

  const [saTokenMaxExpiryEnabled, setSaTokenMaxExpiryEnabled] = useState(false);
  const [saTokenMaxExpiryDays, setSaTokenMaxExpiryDays] = useState<string>("");

  const [jitTokenDefaultEnabled, setJitTokenDefaultEnabled] = useState(false);
  const [jitTokenDefaultTtlSec, setJitTokenDefaultTtlSec] = useState<string>("");

  const [jitTokenMaxEnabled, setJitTokenMaxEnabled] = useState(false);
  const [jitTokenMaxTtlSec, setJitTokenMaxTtlSec] = useState<string>("");

  const currentPolicy = useMemo(() => ({
    saTokenMaxExpiryEnabled,
    saTokenMaxExpiryDays,
    jitTokenDefaultEnabled,
    jitTokenDefaultTtlSec,
    jitTokenMaxEnabled,
    jitTokenMaxTtlSec,
  }), [saTokenMaxExpiryEnabled, saTokenMaxExpiryDays, jitTokenDefaultEnabled, jitTokenDefaultTtlSec, jitTokenMaxEnabled, jitTokenMaxTtlSec]);

  const hasChanges = useFormDirty(currentPolicy, initialPolicy);
  useBeforeUnloadGuard(hasChanges);

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.TENANT_POLICY);
      if (res.ok) {
        const data = await res.json();

        const saExpiry = data.saTokenMaxExpiryDays;
        const saExpiryEnabled = saExpiry !== null && saExpiry !== undefined;
        const saExpiryStr = saExpiryEnabled ? String(saExpiry) : "";

        const jitDefault = data.jitTokenDefaultTtlSec;
        const jitDefaultEnabled = jitDefault !== null && jitDefault !== undefined;
        const jitDefaultStr = jitDefaultEnabled ? String(jitDefault) : "";

        const jitMax = data.jitTokenMaxTtlSec;
        const jitMaxEnabled = jitMax !== null && jitMax !== undefined;
        const jitMaxStr = jitMaxEnabled ? String(jitMax) : "";

        setSaTokenMaxExpiryEnabled(saExpiryEnabled);
        setSaTokenMaxExpiryDays(saExpiryStr);
        setJitTokenDefaultEnabled(jitDefaultEnabled);
        setJitTokenDefaultTtlSec(jitDefaultStr);
        setJitTokenMaxEnabled(jitMaxEnabled);
        setJitTokenMaxTtlSec(jitMaxStr);

        setInitialPolicy({
          saTokenMaxExpiryEnabled: saExpiryEnabled,
          saTokenMaxExpiryDays: saExpiryStr,
          jitTokenDefaultEnabled: jitDefaultEnabled,
          jitTokenDefaultTtlSec: jitDefaultStr,
          jitTokenMaxEnabled: jitMaxEnabled,
          jitTokenMaxTtlSec: jitMaxStr,
        });
      } else {
        toast.error(t("tokenPolicyLoadFailed"));
      }
    } catch {
      toast.error(t("tokenPolicyLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchPolicy();
  }, [fetchPolicy]);

  const validate = (): string | null => {
    if (saTokenMaxExpiryEnabled) {
      if (saTokenMaxExpiryDays === "") return t("saTokenMaxExpiryRequired");
      const n = Number(saTokenMaxExpiryDays);
      if (!Number.isInteger(n) || n < SA_TOKEN_MAX_EXPIRY_MIN) return t("saTokenMaxExpiryValidationMin");
      if (n > SA_TOKEN_MAX_EXPIRY_MAX) return t("saTokenMaxExpiryValidationMax");
    }
    if (jitTokenDefaultEnabled) {
      if (jitTokenDefaultTtlSec === "") return t("jitTokenDefaultRequired");
      const n = Number(jitTokenDefaultTtlSec);
      if (!Number.isInteger(n) || n < JIT_TOKEN_TTL_MIN) return t("jitTokenTtlValidationMin");
      if (n > JIT_TOKEN_TTL_MAX) return t("jitTokenTtlValidationMax");
    }
    if (jitTokenMaxEnabled) {
      if (jitTokenMaxTtlSec === "") return t("jitTokenMaxRequired");
      const n = Number(jitTokenMaxTtlSec);
      if (!Number.isInteger(n) || n < JIT_TOKEN_TTL_MIN) return t("jitTokenTtlValidationMin");
      if (n > JIT_TOKEN_TTL_MAX) return t("jitTokenTtlValidationMax");
    }
    if (jitTokenDefaultEnabled && jitTokenMaxEnabled && jitTokenDefaultTtlSec !== "" && jitTokenMaxTtlSec !== "") {
      const def = Number(jitTokenDefaultTtlSec);
      const max = Number(jitTokenMaxTtlSec);
      if (def > max) return t("jitTokenDefaultExceedsMax");
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
        saTokenMaxExpiryDays: saTokenMaxExpiryEnabled ? Number(saTokenMaxExpiryDays) : null,
        jitTokenDefaultTtlSec: jitTokenDefaultEnabled ? Number(jitTokenDefaultTtlSec) : null,
        jitTokenMaxTtlSec: jitTokenMaxEnabled ? Number(jitTokenMaxTtlSec) : null,
      };
      const res = await fetchApi(API_PATH.TENANT_POLICY, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(t("tokenPolicySaved"));
        setInitialPolicy({ ...currentPolicy });
      } else {
        toast.error(t("tokenPolicySaveFailed"));
      }
    } catch {
      toast.error(t("tokenPolicySaveFailed"));
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
      <SectionCardHeader icon={Key} title={t("tokenPolicyTitle")} description={t("tokenPolicyDescription")} />
      <CardContent className="space-y-4">
        {/* SA Token Max Expiry */}
        <div className="flex items-center justify-between">
          <Label htmlFor="sa-token-max-expiry-toggle">{t("saTokenMaxExpiryEnabled")}</Label>
          <Switch
            id="sa-token-max-expiry-toggle"
            checked={saTokenMaxExpiryEnabled}
            onCheckedChange={(checked) => {
              setSaTokenMaxExpiryEnabled(checked);
              setError(null);
              if (!checked) setSaTokenMaxExpiryDays("");
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("saTokenMaxExpiryEnabledHelp")}</p>

        {saTokenMaxExpiryEnabled && (
          <div className="space-y-2">
            <Label htmlFor="sa-token-max-expiry-days">{t("saTokenMaxExpiryDays")}</Label>
            <Input
              id="sa-token-max-expiry-days"
              type="number"
              min={SA_TOKEN_MAX_EXPIRY_MIN}
              max={SA_TOKEN_MAX_EXPIRY_MAX}
              value={saTokenMaxExpiryDays}
              {...bindRangeInput(setSaTokenMaxExpiryDays, {
                min: SA_TOKEN_MAX_EXPIRY_MIN,
                max: SA_TOKEN_MAX_EXPIRY_MAX,
                onEdit: () => setError(null),
              })}
              placeholder="365"
            />
            <p className="text-xs text-muted-foreground">{t("saTokenMaxExpiryDaysHelp")}</p>
          </div>
        )}

        <hr className="border-border" />

        {/* JIT Token Default TTL */}
        <div className="flex items-center justify-between">
          <Label htmlFor="jit-token-default-toggle">{t("jitTokenDefaultEnabled")}</Label>
          <Switch
            id="jit-token-default-toggle"
            checked={jitTokenDefaultEnabled}
            onCheckedChange={(checked) => {
              setJitTokenDefaultEnabled(checked);
              setError(null);
              if (!checked) setJitTokenDefaultTtlSec("");
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("jitTokenDefaultEnabledHelp")}</p>

        {jitTokenDefaultEnabled && (
          <div className="space-y-2">
            <Label htmlFor="jit-token-default-ttl">{t("jitTokenDefaultTtlSec")}</Label>
            <Input
              id="jit-token-default-ttl"
              type="number"
              min={JIT_TOKEN_TTL_MIN}
              max={JIT_TOKEN_TTL_MAX}
              value={jitTokenDefaultTtlSec}
              {...bindRangeInput(setJitTokenDefaultTtlSec, {
                min: JIT_TOKEN_TTL_MIN,
                max: JIT_TOKEN_TTL_MAX,
                onEdit: () => setError(null),
              })}
              placeholder="3600"
            />
            <p className="text-xs text-muted-foreground">{t("jitTokenDefaultTtlSecHelp")}</p>
          </div>
        )}

        {/* JIT Token Max TTL */}
        <div className="flex items-center justify-between">
          <Label htmlFor="jit-token-max-toggle">{t("jitTokenMaxEnabled")}</Label>
          <Switch
            id="jit-token-max-toggle"
            checked={jitTokenMaxEnabled}
            onCheckedChange={(checked) => {
              setJitTokenMaxEnabled(checked);
              setError(null);
              if (!checked) setJitTokenMaxTtlSec("");
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("jitTokenMaxEnabledHelp")}</p>

        {jitTokenMaxEnabled && (
          <div className="space-y-2">
            <Label htmlFor="jit-token-max-ttl">{t("jitTokenMaxTtlSec")}</Label>
            <Input
              id="jit-token-max-ttl"
              type="number"
              min={JIT_TOKEN_TTL_MIN}
              max={JIT_TOKEN_TTL_MAX}
              value={jitTokenMaxTtlSec}
              {...bindRangeInput(setJitTokenMaxTtlSec, {
                min: JIT_TOKEN_TTL_MIN,
                max: JIT_TOKEN_TTL_MAX,
                onEdit: () => setError(null),
              })}
              placeholder="3600"
            />
            <p className="text-xs text-muted-foreground">{t("jitTokenMaxTtlSecHelp")}</p>
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
            {t("tokenPolicySave")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
