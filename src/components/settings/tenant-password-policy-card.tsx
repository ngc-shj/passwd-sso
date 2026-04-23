"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Lock, Loader2 } from "lucide-react";
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
  POLICY_MIN_PW_LENGTH_MIN,
  POLICY_MIN_PW_LENGTH_MAX,
  PASSWORD_MAX_AGE_MIN,
  PASSWORD_MAX_AGE_MAX,
  PASSWORD_EXPIRY_WARNING_MIN,
  PASSWORD_EXPIRY_WARNING_MAX,
} from "@/lib/validations";
import { useFormDirty } from "@/hooks/form/use-form-dirty";
import { useBeforeUnloadGuard } from "@/hooks/form/use-before-unload-guard";
import { FormDirtyBadge } from "@/components/settings/form-dirty-badge";
import { bindRangeInput } from "@/lib/ui/input-range";

export function TenantPasswordPolicyCard() {
  const t = useTranslations("TenantAdmin");
  const tCommon = useTranslations("Common");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [minPasswordLength, setMinPasswordLength] = useState<string>("");
  const [requireUppercase, setRequireUppercase] = useState(false);
  const [requireLowercase, setRequireLowercase] = useState(false);
  const [requireNumbers, setRequireNumbers] = useState(false);
  const [requireSymbols, setRequireSymbols] = useState(false);
  const [passwordMaxAgeEnabled, setPasswordMaxAgeEnabled] = useState(false);
  const [passwordMaxAgeDays, setPasswordMaxAgeDays] = useState<string>("");
  const [passwordExpiryWarningDays, setPasswordExpiryWarningDays] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [initialPolicy, setInitialPolicy] = useState<Record<string, unknown> | null>(null);

  const currentPolicy = useMemo(() => ({
    minPasswordLength,
    requireUppercase,
    requireLowercase,
    requireNumbers,
    requireSymbols,
    passwordMaxAgeEnabled,
    passwordMaxAgeDays,
    passwordExpiryWarningDays,
  }), [minPasswordLength, requireUppercase, requireLowercase, requireNumbers, requireSymbols, passwordMaxAgeEnabled, passwordMaxAgeDays, passwordExpiryWarningDays]);

  const hasChanges = useFormDirty(currentPolicy, initialPolicy);
  useBeforeUnloadGuard(hasChanges);

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.TENANT_POLICY);
      if (res.ok) {
        const data = await res.json();

        const minLen = data.tenantMinPasswordLength !== null && data.tenantMinPasswordLength !== undefined ? String(data.tenantMinPasswordLength) : "";
        const reqUpper = data.tenantRequireUppercase ?? false;
        const reqLower = data.tenantRequireLowercase ?? false;
        const reqNums = data.tenantRequireNumbers ?? false;
        const reqSyms = data.tenantRequireSymbols ?? false;
        const maxAge = data.passwordMaxAgeDays;
        const maxAgeEnabled = maxAge !== null && maxAge !== undefined;
        const maxAgeStr = maxAgeEnabled ? String(maxAge) : "";
        const warningVal = data.passwordExpiryWarningDays;
        const warningStr = warningVal !== null && warningVal !== undefined ? String(warningVal) : "";

        setMinPasswordLength(minLen);
        setRequireUppercase(reqUpper);
        setRequireLowercase(reqLower);
        setRequireNumbers(reqNums);
        setRequireSymbols(reqSyms);
        setPasswordMaxAgeEnabled(maxAgeEnabled);
        setPasswordMaxAgeDays(maxAgeStr);
        setPasswordExpiryWarningDays(warningStr);

        setInitialPolicy({
          minPasswordLength: minLen,
          requireUppercase: reqUpper,
          requireLowercase: reqLower,
          requireNumbers: reqNums,
          requireSymbols: reqSyms,
          passwordMaxAgeEnabled: maxAgeEnabled,
          passwordMaxAgeDays: maxAgeStr,
          passwordExpiryWarningDays: warningStr,
        });
      } else {
        toast.error(t("passwordPolicyLoadFailed"));
      }
    } catch {
      toast.error(t("passwordPolicyLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchPolicy();
  }, [fetchPolicy]);

  const validate = (): string | null => {
    if (minPasswordLength !== "") {
      const num = Number(minPasswordLength);
      if (!Number.isInteger(num) || num < POLICY_MIN_PW_LENGTH_MIN) return t("passwordMinLengthValidationMin");
      if (num > POLICY_MIN_PW_LENGTH_MAX) return t("passwordMinLengthValidationMax");
    }
    if (passwordMaxAgeEnabled) {
      if (passwordMaxAgeDays === "") return t("passwordMaxAgeRequired");
      const num = Number(passwordMaxAgeDays);
      if (!Number.isInteger(num) || num < PASSWORD_MAX_AGE_MIN) return t("passwordMaxAgeValidationMin");
      if (num > PASSWORD_MAX_AGE_MAX) return t("passwordMaxAgeValidationMax");
    }
    if (passwordExpiryWarningDays !== "") {
      const num = Number(passwordExpiryWarningDays);
      if (!Number.isInteger(num) || num < PASSWORD_EXPIRY_WARNING_MIN) return t("passwordExpiryWarningValidationMin");
      if (num > PASSWORD_EXPIRY_WARNING_MAX) return t("passwordExpiryWarningValidationMax");
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
        tenantMinPasswordLength: minPasswordLength !== "" ? Number(minPasswordLength) : null,
        tenantRequireUppercase: requireUppercase,
        tenantRequireLowercase: requireLowercase,
        tenantRequireNumbers: requireNumbers,
        tenantRequireSymbols: requireSymbols,
        passwordMaxAgeDays: passwordMaxAgeEnabled ? Number(passwordMaxAgeDays) : null,
        passwordExpiryWarningDays: passwordExpiryWarningDays !== "" ? Number(passwordExpiryWarningDays) : null,
      };
      const res = await fetchApi(API_PATH.TENANT_POLICY, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(t("passwordPolicySaved"));
        setInitialPolicy({ ...currentPolicy });
      } else {
        toast.error(t("passwordPolicySaveFailed"));
      }
    } catch {
      toast.error(t("passwordPolicySaveFailed"));
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
      <SectionCardHeader icon={Lock} title={t("passwordPolicyTitle")} description={t("passwordPolicyDescription")} />
      <CardContent className="space-y-4">
        {/* Minimum password length */}
        <div className="space-y-2">
          <Label htmlFor="tenant-min-password-length">{t("tenantMinPasswordLength")}</Label>
          <Input
            id="tenant-min-password-length"
            type="number"
            min={POLICY_MIN_PW_LENGTH_MIN}
            max={POLICY_MIN_PW_LENGTH_MAX}
            value={minPasswordLength}
            {...bindRangeInput(setMinPasswordLength, {
              min: POLICY_MIN_PW_LENGTH_MIN,
              max: POLICY_MIN_PW_LENGTH_MAX,
              onEdit: () => setError(null),
            })}
            placeholder="0"
          />
          <p className="text-xs text-muted-foreground">{t("tenantMinPasswordLengthHelp")}</p>
        </div>

        {/* Character requirements */}
        <div className="flex items-center justify-between">
          <Label htmlFor="require-uppercase-toggle">{t("tenantRequireUppercase")}</Label>
          <Switch
            id="require-uppercase-toggle"
            checked={requireUppercase}
            onCheckedChange={setRequireUppercase}
          />
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor="require-lowercase-toggle">{t("tenantRequireLowercase")}</Label>
          <Switch
            id="require-lowercase-toggle"
            checked={requireLowercase}
            onCheckedChange={setRequireLowercase}
          />
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor="require-numbers-toggle">{t("tenantRequireNumbers")}</Label>
          <Switch
            id="require-numbers-toggle"
            checked={requireNumbers}
            onCheckedChange={setRequireNumbers}
          />
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor="require-symbols-toggle">{t("tenantRequireSymbols")}</Label>
          <Switch
            id="require-symbols-toggle"
            checked={requireSymbols}
            onCheckedChange={setRequireSymbols}
          />
        </div>

        <Separator />

        {/* Password max age */}
        <div className="flex items-center justify-between">
          <Label htmlFor="password-max-age-toggle">{t("passwordMaxAgeEnabled")}</Label>
          <Switch
            id="password-max-age-toggle"
            checked={passwordMaxAgeEnabled}
            onCheckedChange={(checked) => {
              setPasswordMaxAgeEnabled(checked);
              setError(null);
              if (!checked) {
                setPasswordMaxAgeDays("");
                setPasswordExpiryWarningDays("");
              }
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("passwordMaxAgeEnabledHelp")}</p>

        {passwordMaxAgeEnabled && (
          <>
            <div className="space-y-2">
              <Label htmlFor="password-max-age-days">{t("passwordMaxAgeDays")}</Label>
              <Input
                id="password-max-age-days"
                type="number"
                min={PASSWORD_MAX_AGE_MIN}
                max={PASSWORD_MAX_AGE_MAX}
                value={passwordMaxAgeDays}
                {...bindRangeInput(setPasswordMaxAgeDays, {
                  min: PASSWORD_MAX_AGE_MIN,
                  max: PASSWORD_MAX_AGE_MAX,
                  onEdit: () => setError(null),
                })}
                placeholder="90"
              />
              <p className="text-xs text-muted-foreground">{t("passwordMaxAgeDaysHelp")}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password-expiry-warning-days">{t("passwordExpiryWarningDays")}</Label>
              <Input
                id="password-expiry-warning-days"
                type="number"
                min={PASSWORD_EXPIRY_WARNING_MIN}
                max={PASSWORD_EXPIRY_WARNING_MAX}
                value={passwordExpiryWarningDays}
                {...bindRangeInput(setPasswordExpiryWarningDays, {
                  min: PASSWORD_EXPIRY_WARNING_MIN,
                  max: PASSWORD_EXPIRY_WARNING_MAX,
                  onEdit: () => setError(null),
                })}
                placeholder="14"
              />
              <p className="text-xs text-muted-foreground">{t("passwordExpiryWarningDaysHelp")}</p>
            </div>
          </>
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
            {t("passwordPolicySave")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
