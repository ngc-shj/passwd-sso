"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useFormDirty } from "@/hooks/use-form-dirty";
import { useBeforeUnloadGuard } from "@/hooks/use-before-unload-guard";
import { FormDirtyBadge } from "@/components/settings/form-dirty-badge";
import { toast } from "sonner";
import { ListChecks, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/section-card-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { fetchApi } from "@/lib/url-helpers";
import {
  POLICY_MIN_PW_LENGTH_MIN,
  POLICY_MIN_PW_LENGTH_MAX,
  POLICY_SESSION_DURATION_MIN,
  POLICY_SESSION_DURATION_MAX,
  PASSWORD_HISTORY_COUNT_MAX,
  MAX_CIDRS,
} from "@/lib/validations";

interface PolicyData {
  minPasswordLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumbers: boolean;
  requireSymbols: boolean;
  maxSessionDurationMinutes: number | null;
  requireRepromptForAll: boolean;
  allowExport: boolean;
  allowSharing: boolean;
  requireSharePassword: boolean;
  passwordHistoryCount: number;
  inheritTenantCidrs: boolean;
  teamAllowedCidrs: string[];
}

const DEFAULT_POLICY: PolicyData = {
  minPasswordLength: 0,
  requireUppercase: false,
  requireLowercase: false,
  requireNumbers: false,
  requireSymbols: false,
  maxSessionDurationMinutes: null,
  requireRepromptForAll: false,
  allowExport: true,
  allowSharing: true,
  requireSharePassword: false,
  passwordHistoryCount: 0,
  inheritTenantCidrs: true,
  teamAllowedCidrs: [],
};

/** Validate policy fields. Returns a map of field name → error key (i18n). */
export function validatePolicy(
  policy: Pick<PolicyData, "minPasswordLength" | "maxSessionDurationMinutes">,
): Record<string, string> {
  const errs: Record<string, string> = {};
  const pwLen = policy.minPasswordLength;
  if (Number.isNaN(pwLen) || pwLen < POLICY_MIN_PW_LENGTH_MIN || pwLen > POLICY_MIN_PW_LENGTH_MAX) {
    errs.minPasswordLength = "minPasswordLengthRange";
  }
  const dur = policy.maxSessionDurationMinutes;
  if (dur !== null && (Number.isNaN(dur) || dur < POLICY_SESSION_DURATION_MIN || dur > POLICY_SESSION_DURATION_MAX)) {
    errs.maxSessionDurationMinutes = "maxSessionDurationRange";
  }
  return errs;
}

interface TeamPolicySettingsProps {
  teamId: string;
}

export function TeamPolicySettings({ teamId }: TeamPolicySettingsProps) {
  const t = useTranslations("TeamPolicy");
  const tCommon = useTranslations("Common");
  const [policy, setPolicy] = useState<PolicyData>(DEFAULT_POLICY);
  const [initialPolicy, setInitialPolicy] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Internal text representation for teamAllowedCidrs textarea
  const [teamCidrsText, setTeamCidrsText] = useState("");

  const hasChanges = useFormDirty(policy as unknown as Record<string, unknown>, initialPolicy);
  useBeforeUnloadGuard(hasChanges);

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await fetchApi(`/api/teams/${teamId}/policy`);
      if (res.ok) {
        const data = await res.json();
        const cidrsText = (data.teamAllowedCidrs ?? []).join("\n");
        setTeamCidrsText(cidrsText);
        setPolicy({ ...DEFAULT_POLICY, ...data });
        setInitialPolicy({ ...DEFAULT_POLICY, ...data });
      } else {
        toast.error(t("fetchError"));
      }
    } catch {
      toast.error(t("fetchError"));
    } finally {
      setLoading(false);
    }
  }, [teamId, t]);

  useEffect(() => {
    fetchPolicy();
  }, [fetchPolicy]);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const rawErrs = validatePolicy(policy);
    const translated: Record<string, string> = {};
    for (const [key, msgKey] of Object.entries(rawErrs)) {
      translated[key] = t(msgKey);
    }
    setFieldErrors(translated);
    return Object.keys(rawErrs).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;

    setSaving(true);
    try {
      const teamAllowedCidrs = teamCidrsText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const payload = { ...policy, teamAllowedCidrs };
      const res = await fetchApi(`/api/teams/${teamId}/policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const saved = await res.json();
        const savedCidrsText = (saved.teamAllowedCidrs ?? []).join("\n");
        setTeamCidrsText(savedCidrsText);
        setPolicy({ ...DEFAULT_POLICY, ...saved });
        setInitialPolicy({ ...DEFAULT_POLICY, ...saved });
        setFieldErrors({});
        toast.success(t("saveSuccess"));
      } else if (res.status === 400) {
        toast.error(t("validationError"));
      } else {
        toast.error(t("saveError"));
      }
    } catch {
      toast.error(t("saveError"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <SectionCardHeader icon={ListChecks} title={t("title")} description={t("description")} />
      <CardContent className="space-y-4">
        {/* Password Requirements */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">{t("passwordRequirements")}</h3>
          <div className="space-y-2">
            <Label>{t("minPasswordLength")}</Label>
            <Input
              type="number"
              min={POLICY_MIN_PW_LENGTH_MIN}
              max={POLICY_MIN_PW_LENGTH_MAX}
              value={policy.minPasswordLength}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10);
                const value = Number.isNaN(parsed) ? 0 : Math.max(POLICY_MIN_PW_LENGTH_MIN, Math.min(POLICY_MIN_PW_LENGTH_MAX, parsed));
                setPolicy((p) => ({ ...p, minPasswordLength: value }));
                setFieldErrors((prev) => {
                  const { minPasswordLength: _, ...rest } = prev;
                  return rest;
                });
              }}
              className="max-w-[200px]"
            />
            {fieldErrors.minPasswordLength && (
              <p className="text-sm text-destructive">{fieldErrors.minPasswordLength}</p>
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <SwitchField
              label={t("requireUppercase")}
              checked={policy.requireUppercase}
              onChange={(v) => setPolicy((p) => ({ ...p, requireUppercase: v }))}
            />
            <SwitchField
              label={t("requireLowercase")}
              checked={policy.requireLowercase}
              onChange={(v) => setPolicy((p) => ({ ...p, requireLowercase: v }))}
            />
            <SwitchField
              label={t("requireNumbers")}
              checked={policy.requireNumbers}
              onChange={(v) => setPolicy((p) => ({ ...p, requireNumbers: v }))}
            />
            <SwitchField
              label={t("requireSymbols")}
              checked={policy.requireSymbols}
              onChange={(v) => setPolicy((p) => ({ ...p, requireSymbols: v }))}
            />
          </div>
        </div>

        <Separator />

        {/* Access Control */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">{t("accessControl")}</h3>
          <SwitchField
            label={t("allowExport")}
            checked={policy.allowExport}
            onChange={(v) => setPolicy((p) => ({ ...p, allowExport: v }))}
          />
          <div className="border rounded-md p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <Label className="cursor-pointer">{t("allowSharing")}</Label>
              <Switch
                checked={policy.allowSharing}
                onCheckedChange={(v) =>
                  setPolicy((p) => ({
                    ...p,
                    allowSharing: v,
                    ...(v ? {} : { requireSharePassword: false }),
                  }))
                }
              />
            </div>
            {policy.allowSharing && (
              <div className="ml-4 border-l-2 border-muted pl-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="cursor-pointer text-sm">
                    {t("requireSharePassword")}
                  </Label>
                  <Switch
                    checked={policy.requireSharePassword}
                    onCheckedChange={(v) =>
                      setPolicy((p) => ({ ...p, requireSharePassword: v }))
                    }
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <Separator />

        {/* Advanced */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">{t("advanced")}</h3>
          <div className="space-y-2">
            <Label>{t("maxSessionDurationMinutes")}</Label>
            <Input
              type="number"
              min={POLICY_SESSION_DURATION_MIN}
              max={POLICY_SESSION_DURATION_MAX}
              value={policy.maxSessionDurationMinutes ?? ""}
              onChange={(e) => {
                if (!e.target.value) {
                  setPolicy((p) => ({ ...p, maxSessionDurationMinutes: null }));
                } else {
                  const parsed = parseInt(e.target.value, 10);
                  if (Number.isNaN(parsed) || parsed < POLICY_SESSION_DURATION_MIN) {
                    setPolicy((p) => ({ ...p, maxSessionDurationMinutes: null }));
                  } else {
                    const value = Math.min(POLICY_SESSION_DURATION_MAX, parsed);
                    setPolicy((p) => ({ ...p, maxSessionDurationMinutes: value }));
                  }
                }
                setFieldErrors((prev) => {
                  const { maxSessionDurationMinutes: _, ...rest } = prev;
                  return rest;
                });
              }}
              placeholder={t("maxSessionDurationHelp")}
              className="max-w-[200px]"
            />
            {fieldErrors.maxSessionDurationMinutes && (
              <p className="text-sm text-destructive">{fieldErrors.maxSessionDurationMinutes}</p>
            )}
          </div>
          <SwitchField
            label={t("requireRepromptForAll")}
            checked={policy.requireRepromptForAll}
            onChange={(v) =>
              setPolicy((p) => ({ ...p, requireRepromptForAll: v }))
            }
          />
        </div>

        <Separator />

        {/* Password Reuse Prevention */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">{t("passwordReusePrevention")}</h3>
          <div className="space-y-2">
            <Label>{t("passwordHistoryCount")}</Label>
            <Input
              type="number"
              min={0}
              max={PASSWORD_HISTORY_COUNT_MAX}
              value={policy.passwordHistoryCount}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10);
                const value = Number.isNaN(parsed) ? 0 : Math.max(0, Math.min(PASSWORD_HISTORY_COUNT_MAX, parsed));
                setPolicy((p) => ({ ...p, passwordHistoryCount: value }));
              }}
              className="max-w-[200px]"
            />
            <p className="text-xs text-muted-foreground">{t("passwordHistoryCountHelp")}</p>
          </div>
        </div>

        <Separator />

        {/* Team IP Restriction */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">{t("teamIpRestriction")}</h3>
          <SwitchField
            label={t("inheritTenantCidrs")}
            checked={policy.inheritTenantCidrs}
            onChange={(v) => setPolicy((p) => ({ ...p, inheritTenantCidrs: v }))}
          />
          <div className="space-y-2">
            <Label>{t("teamAllowedCidrs")}</Label>
            <Textarea
              rows={4}
              value={teamCidrsText}
              onChange={(e) => setTeamCidrsText(e.target.value)}
              placeholder={t("teamAllowedCidrsPlaceholder")}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">{t("teamAllowedCidrsHelp", { max: MAX_CIDRS })}</p>
          </div>
        </div>

        <div className="flex items-center justify-between pt-1">
          <FormDirtyBadge
            hasChanges={hasChanges}
            unsavedLabel={tCommon("statusUnsaved")}
            savedLabel={tCommon("statusSaved")}
          />
          <Button onClick={handleSave} disabled={saving || !hasChanges}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {saving ? t("saving") : t("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SwitchField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border rounded-md p-3">
      <Label className="cursor-pointer">{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
