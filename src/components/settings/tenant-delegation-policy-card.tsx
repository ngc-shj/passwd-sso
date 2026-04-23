"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Handshake, Loader2 } from "lucide-react";
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
  DELEGATION_TTL_MIN,
  DELEGATION_TTL_MAX,
} from "@/lib/validations";
import { useFormDirty } from "@/hooks/form/use-form-dirty";
import { useBeforeUnloadGuard } from "@/hooks/form/use-before-unload-guard";
import { FormDirtyBadge } from "@/components/settings/form-dirty-badge";
import { bindRangeInput } from "@/lib/input-range";

export function TenantDelegationPolicyCard() {
  const t = useTranslations("TenantAdmin");
  const tCommon = useTranslations("Common");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialPolicy, setInitialPolicy] = useState<Record<string, unknown> | null>(null);

  const [delegationDefaultEnabled, setDelegationDefaultEnabled] = useState(false);
  const [delegationDefaultTtlSec, setDelegationDefaultTtlSec] = useState<string>("");

  const [delegationMaxEnabled, setDelegationMaxEnabled] = useState(false);
  const [delegationMaxTtlSec, setDelegationMaxTtlSec] = useState<string>("");

  const currentPolicy = useMemo(() => ({
    delegationDefaultEnabled,
    delegationDefaultTtlSec,
    delegationMaxEnabled,
    delegationMaxTtlSec,
  }), [delegationDefaultEnabled, delegationDefaultTtlSec, delegationMaxEnabled, delegationMaxTtlSec]);

  const hasChanges = useFormDirty(currentPolicy, initialPolicy);
  useBeforeUnloadGuard(hasChanges);

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.TENANT_POLICY);
      if (res.ok) {
        const data = await res.json();

        const delegDefault = data.delegationDefaultTtlSec;
        const delegDefaultEnabled = delegDefault !== null && delegDefault !== undefined;
        const delegDefaultStr = delegDefaultEnabled ? String(delegDefault) : "";

        const delegMax = data.delegationMaxTtlSec;
        const delegMaxEnabled = delegMax !== null && delegMax !== undefined;
        const delegMaxStr = delegMaxEnabled ? String(delegMax) : "";

        setDelegationDefaultEnabled(delegDefaultEnabled);
        setDelegationDefaultTtlSec(delegDefaultStr);
        setDelegationMaxEnabled(delegMaxEnabled);
        setDelegationMaxTtlSec(delegMaxStr);

        setInitialPolicy({
          delegationDefaultEnabled: delegDefaultEnabled,
          delegationDefaultTtlSec: delegDefaultStr,
          delegationMaxEnabled: delegMaxEnabled,
          delegationMaxTtlSec: delegMaxStr,
        });
      } else {
        toast.error(t("delegationPolicyLoadFailed"));
      }
    } catch {
      toast.error(t("delegationPolicyLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchPolicy();
  }, [fetchPolicy]);

  const validate = (): string | null => {
    if (delegationDefaultEnabled) {
      if (delegationDefaultTtlSec === "") return t("delegationDefaultRequired");
      const n = Number(delegationDefaultTtlSec);
      if (!Number.isInteger(n) || n < DELEGATION_TTL_MIN) return t("delegationTtlValidationMin");
      if (n > DELEGATION_TTL_MAX) return t("delegationTtlValidationMax");
    }
    if (delegationMaxEnabled) {
      if (delegationMaxTtlSec === "") return t("delegationMaxRequired");
      const n = Number(delegationMaxTtlSec);
      if (!Number.isInteger(n) || n < DELEGATION_TTL_MIN) return t("delegationTtlValidationMin");
      if (n > DELEGATION_TTL_MAX) return t("delegationTtlValidationMax");
    }
    if (delegationDefaultEnabled && delegationMaxEnabled && delegationDefaultTtlSec !== "" && delegationMaxTtlSec !== "") {
      const def = Number(delegationDefaultTtlSec);
      const max = Number(delegationMaxTtlSec);
      if (def > max) return t("delegationDefaultExceedsMax");
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
        delegationDefaultTtlSec: delegationDefaultEnabled ? Number(delegationDefaultTtlSec) : null,
        delegationMaxTtlSec: delegationMaxEnabled ? Number(delegationMaxTtlSec) : null,
      };
      const res = await fetchApi(API_PATH.TENANT_POLICY, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(t("delegationPolicySaved"));
        setInitialPolicy({ ...currentPolicy });
      } else {
        toast.error(t("delegationPolicySaveFailed"));
      }
    } catch {
      toast.error(t("delegationPolicySaveFailed"));
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
      <SectionCardHeader icon={Handshake} title={t("delegationPolicyTitle")} description={t("delegationPolicyDescription")} />
      <CardContent className="space-y-4">
        {/* Delegation Default TTL */}
        <div className="flex items-center justify-between">
          <Label htmlFor="delegation-default-toggle">{t("delegationDefaultEnabled")}</Label>
          <Switch
            id="delegation-default-toggle"
            checked={delegationDefaultEnabled}
            onCheckedChange={(checked) => {
              setDelegationDefaultEnabled(checked);
              setError(null);
              if (!checked) setDelegationDefaultTtlSec("");
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("delegationDefaultEnabledHelp")}</p>

        {delegationDefaultEnabled && (
          <div className="space-y-2">
            <Label htmlFor="delegation-default-ttl">{t("delegationDefaultTtlSec")}</Label>
            <Input
              id="delegation-default-ttl"
              type="number"
              min={DELEGATION_TTL_MIN}
              max={DELEGATION_TTL_MAX}
              value={delegationDefaultTtlSec}
              {...bindRangeInput(setDelegationDefaultTtlSec, {
                min: DELEGATION_TTL_MIN,
                max: DELEGATION_TTL_MAX,
                onEdit: () => setError(null),
              })}
              placeholder="3600"
            />
            <p className="text-xs text-muted-foreground">{t("delegationDefaultTtlSecHelp")}</p>
          </div>
        )}

        {/* Delegation Max TTL */}
        <div className="flex items-center justify-between">
          <Label htmlFor="delegation-max-toggle">{t("delegationMaxEnabled")}</Label>
          <Switch
            id="delegation-max-toggle"
            checked={delegationMaxEnabled}
            onCheckedChange={(checked) => {
              setDelegationMaxEnabled(checked);
              setError(null);
              if (!checked) setDelegationMaxTtlSec("");
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("delegationMaxEnabledHelp")}</p>

        {delegationMaxEnabled && (
          <div className="space-y-2">
            <Label htmlFor="delegation-max-ttl">{t("delegationMaxTtlSec")}</Label>
            <Input
              id="delegation-max-ttl"
              type="number"
              min={DELEGATION_TTL_MIN}
              max={DELEGATION_TTL_MAX}
              value={delegationMaxTtlSec}
              {...bindRangeInput(setDelegationMaxTtlSec, {
                min: DELEGATION_TTL_MIN,
                max: DELEGATION_TTL_MAX,
                onEdit: () => setError(null),
              })}
              placeholder="3600"
            />
            <p className="text-xs text-muted-foreground">{t("delegationMaxTtlSecHelp")}</p>
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
            {t("delegationPolicySave")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
