"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { KeyRound, Loader2 } from "lucide-react";
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
  PASSKEY_GRACE_PERIOD_MIN,
  PASSKEY_GRACE_PERIOD_MAX,
  PIN_LENGTH_MIN,
  PIN_LENGTH_MAX,
} from "@/lib/validations";
import { useFormDirty } from "@/hooks/form/use-form-dirty";
import { useBeforeUnloadGuard } from "@/hooks/form/use-before-unload-guard";
import { FormDirtyBadge } from "@/components/settings/form-dirty-badge";
import { bindRangeInput } from "@/lib/ui/input-range";

export function TenantPasskeyPolicyCard() {
  const t = useTranslations("TenantAdmin");
  const tCommon = useTranslations("Common");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [requirePasskey, setRequirePasskey] = useState(false);
  const [gracePeriodDays, setGracePeriodDays] = useState<string>("");
  const [requireMinPinLength, setRequireMinPinLength] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [initialPolicy, setInitialPolicy] = useState<Record<string, unknown> | null>(null);

  const currentPolicy = useMemo(() => ({
    requirePasskey,
    gracePeriodDays,
    requireMinPinLength,
  }), [requirePasskey, gracePeriodDays, requireMinPinLength]);

  const hasChanges = useFormDirty(currentPolicy, initialPolicy);
  useBeforeUnloadGuard(hasChanges);

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.TENANT_POLICY);
      if (res.ok) {
        const data = await res.json();

        const requirePasskeyVal = data.requirePasskey ?? false;
        const graceVal = data.passkeyGracePeriodDays;
        const gracePeriodVal = graceVal !== null && graceVal !== undefined ? String(graceVal) : "";
        const pinVal = data.requireMinPinLength;
        const pinLengthVal = pinVal !== null && pinVal !== undefined ? String(pinVal) : "";

        setRequirePasskey(requirePasskeyVal);
        setGracePeriodDays(gracePeriodVal);
        setRequireMinPinLength(pinLengthVal);

        setInitialPolicy({
          requirePasskey: requirePasskeyVal,
          gracePeriodDays: gracePeriodVal,
          requireMinPinLength: pinLengthVal,
        });
      } else {
        toast.error(t("passkeyPolicyLoadFailed"));
      }
    } catch {
      toast.error(t("passkeyPolicyLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchPolicy();
  }, [fetchPolicy]);

  const validate = (): string | null => {
    if (requirePasskey && gracePeriodDays !== "") {
      const num = Number(gracePeriodDays);
      if (!Number.isInteger(num) || num < PASSKEY_GRACE_PERIOD_MIN) return t("passkeyGracePeriodValidationMin");
      if (num > PASSKEY_GRACE_PERIOD_MAX) return t("passkeyGracePeriodValidationMax");
    }
    if (requireMinPinLength !== "") {
      const num = Number(requireMinPinLength);
      if (!Number.isInteger(num) || num < PIN_LENGTH_MIN) return t("passkeyMinPinLengthValidationMin");
      if (num > PIN_LENGTH_MAX) return t("passkeyMinPinLengthValidationMax");
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
        requirePasskey,
        passkeyGracePeriodDays: requirePasskey && gracePeriodDays !== "" ? Number(gracePeriodDays) : null,
        requireMinPinLength: requireMinPinLength !== "" ? Number(requireMinPinLength) : null,
      };
      const res = await fetchApi(API_PATH.TENANT_POLICY, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(t("passkeyPolicySaved"));
        setInitialPolicy({ ...currentPolicy });
      } else {
        toast.error(t("passkeyPolicySaveFailed"));
      }
    } catch {
      toast.error(t("passkeyPolicySaveFailed"));
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
      <SectionCardHeader icon={KeyRound} title={t("passkeyPolicyTitle")} description={t("passkeyPolicyDescription")} />
      <CardContent className="space-y-4">
        {/* Require passkey */}
        <div className="flex items-center justify-between">
          <Label htmlFor="require-passkey-toggle">{t("requirePasskey")}</Label>
          <Switch
            id="require-passkey-toggle"
            checked={requirePasskey}
            onCheckedChange={(checked) => {
              setRequirePasskey(checked);
              setError(null);
              if (!checked) setGracePeriodDays("");
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("requirePasskeyHelp")}</p>

        {requirePasskey && (
          <div className="space-y-2">
            <Label htmlFor="grace-period-days">{t("passkeyGracePeriodDays")}</Label>
            <Input
              id="grace-period-days"
              type="number"
              min={PASSKEY_GRACE_PERIOD_MIN}
              max={PASSKEY_GRACE_PERIOD_MAX}
              value={gracePeriodDays}
              {...bindRangeInput(setGracePeriodDays, {
                min: PASSKEY_GRACE_PERIOD_MIN,
                max: PASSKEY_GRACE_PERIOD_MAX,
                onEdit: () => setError(null),
              })}
              placeholder="30"
            />
            <p className="text-xs text-muted-foreground">{t("passkeyGracePeriodHelp")}</p>
          </div>
        )}

        {/* Minimum PIN length */}
        <div className="space-y-2">
          <Label htmlFor="min-pin-length">{t("requireMinPinLength")}</Label>
          <Input
            id="min-pin-length"
            type="number"
            min={PIN_LENGTH_MIN}
            max={PIN_LENGTH_MAX}
            value={requireMinPinLength}
            {...bindRangeInput(setRequireMinPinLength, {
              min: PIN_LENGTH_MIN,
              max: PIN_LENGTH_MAX,
              onEdit: () => setError(null),
            })}
            placeholder="6"
          />
          <p className="text-xs text-muted-foreground">{t("requireMinPinLengthHelp")}</p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center justify-between">
          <FormDirtyBadge
            hasChanges={hasChanges}
            unsavedLabel={tCommon("statusUnsaved")}
            savedLabel={tCommon("statusSaved")}
          />
          <Button onClick={handleSave} disabled={saving || !hasChanges}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("passkeyPolicySave")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
