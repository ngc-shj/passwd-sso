"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Archive, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import {
  AUDIT_LOG_RETENTION_MIN,
  AUDIT_LOG_RETENTION_MAX,
  RETENTION_DAYS_MIN,
  RETENTION_DAYS_MAX,
} from "@/lib/validations";
import { useFormDirty } from "@/hooks/form/use-form-dirty";
import { useBeforeUnloadGuard } from "@/hooks/form/use-before-unload-guard";
import { FormDirtyBadge } from "@/components/settings/account/form-dirty-badge";
import { bindRangeInput } from "@/lib/ui/input-range";

// The 5 generic retention fields share a single [min, max] bound and the
// "toggle on → integer days, off → null (never auto-delete)" pattern.
// auditLogRetentionDays keeps its own stricter 30-day forensic floor and is
// handled separately below.
const GENERIC_FIELDS = [
  { key: "trashRetentionDays", labelKey: "trashRetention" },
  { key: "historyRetentionDays", labelKey: "historyRetention" },
  { key: "shareAccessLogRetentionDays", labelKey: "shareAccessLogRetention" },
  { key: "directorySyncLogRetentionDays", labelKey: "directorySyncLogRetention" },
  { key: "notificationRetentionDays", labelKey: "notificationRetention" },
] as const;

type GenericFieldKey = (typeof GENERIC_FIELDS)[number]["key"];

type GenericState = {
  enabled: Record<GenericFieldKey, boolean>;
  days: Record<GenericFieldKey, string>;
};

const VAULT_DATA_KEYS: GenericFieldKey[] = ["trashRetentionDays", "historyRetentionDays"];
const LOG_KEYS: GenericFieldKey[] = [
  "shareAccessLogRetentionDays",
  "directorySyncLogRetentionDays",
  "notificationRetentionDays",
];

const labelKeyOf = (field: GenericFieldKey): string =>
  GENERIC_FIELDS.find((f) => f.key === field)!.labelKey;

function emptyGenericState(): GenericState {
  const enabled = {} as Record<GenericFieldKey, boolean>;
  const days = {} as Record<GenericFieldKey, string>;
  for (const { key } of GENERIC_FIELDS) {
    enabled[key] = false;
    days[key] = "";
  }
  return { enabled, days };
}

export function TenantRetentionPolicyCard() {
  const t = useTranslations("TenantAdmin");
  const tCommon = useTranslations("Common");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [auditLogRetentionEnabled, setAuditLogRetentionEnabled] = useState(false);
  const [auditLogRetentionDays, setAuditLogRetentionDays] = useState<string>("");
  const [generic, setGeneric] = useState<GenericState>(emptyGenericState);
  const [error, setError] = useState<string | null>(null);
  const [initialPolicy, setInitialPolicy] = useState<Record<string, unknown> | null>(null);

  const currentPolicy = useMemo(() => ({
    auditLogRetentionEnabled,
    auditLogRetentionDays,
    enabled: generic.enabled,
    days: generic.days,
  }), [auditLogRetentionEnabled, auditLogRetentionDays, generic]);

  const hasChanges = useFormDirty(currentPolicy, initialPolicy);
  useBeforeUnloadGuard(hasChanges);

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.TENANT_POLICY);
      if (res.ok) {
        const data = await res.json();

        const retentionVal = data.auditLogRetentionDays;
        const retentionEnabled = retentionVal !== null && retentionVal !== undefined;
        const retentionStr = retentionEnabled ? String(retentionVal) : "";

        setAuditLogRetentionEnabled(retentionEnabled);
        setAuditLogRetentionDays(retentionStr);

        const nextGeneric = emptyGenericState();
        for (const { key } of GENERIC_FIELDS) {
          const val = data[key];
          const enabled = val !== null && val !== undefined;
          nextGeneric.enabled[key] = enabled;
          nextGeneric.days[key] = enabled ? String(val) : "";
        }
        setGeneric(nextGeneric);

        setInitialPolicy({
          auditLogRetentionEnabled: retentionEnabled,
          auditLogRetentionDays: retentionStr,
          enabled: { ...nextGeneric.enabled },
          days: { ...nextGeneric.days },
        });
      } else {
        toast.error(t("retentionPolicyLoadFailed"));
      }
    } catch {
      toast.error(t("retentionPolicyLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchPolicy();
  }, [fetchPolicy]);

  const setGenericEnabled = (field: GenericFieldKey, checked: boolean) => {
    setError(null);
    setGeneric((prev) => ({
      enabled: { ...prev.enabled, [field]: checked },
      days: { ...prev.days, [field]: checked ? prev.days[field] : "" },
    }));
  };

  const setGenericDays = (field: GenericFieldKey, value: string) => {
    setGeneric((prev) => ({
      enabled: prev.enabled,
      days: { ...prev.days, [field]: value },
    }));
  };

  const validate = (): string | null => {
    if (auditLogRetentionEnabled) {
      if (auditLogRetentionDays === "") return t("auditLogRetentionRequired");
      const num = Number(auditLogRetentionDays);
      if (!Number.isInteger(num) || num < AUDIT_LOG_RETENTION_MIN) return t("auditLogRetentionValidationMin", { min: AUDIT_LOG_RETENTION_MIN });
      if (num > AUDIT_LOG_RETENTION_MAX) return t("auditLogRetentionValidationMax", { max: AUDIT_LOG_RETENTION_MAX });
    }
    for (const { key } of GENERIC_FIELDS) {
      if (!generic.enabled[key]) continue;
      const labelKey = labelKeyOf(key);
      if (generic.days[key] === "") return t(`${labelKey}Required`);
      const num = Number(generic.days[key]);
      if (!Number.isInteger(num) || num < RETENTION_DAYS_MIN) return t(`${labelKey}ValidationMin`, { min: RETENTION_DAYS_MIN });
      if (num > RETENTION_DAYS_MAX) return t(`${labelKey}ValidationMax`, { max: RETENTION_DAYS_MAX });
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
      const body: Record<string, number | null> = {
        auditLogRetentionDays: auditLogRetentionEnabled ? Number(auditLogRetentionDays) : null,
      };
      for (const { key } of GENERIC_FIELDS) {
        body[key] = generic.enabled[key] ? Number(generic.days[key]) : null;
      }
      const res = await fetchApi(API_PATH.TENANT_POLICY, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(t("retentionPolicySaved"));
        setInitialPolicy({
          auditLogRetentionEnabled,
          auditLogRetentionDays,
          enabled: { ...generic.enabled },
          days: { ...generic.days },
        });
      } else {
        toast.error(t("retentionPolicySaveFailed"));
      }
    } catch {
      toast.error(t("retentionPolicySaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const renderGenericField = (field: GenericFieldKey) => {
    const labelKey = labelKeyOf(field);
    const toggleId = `${field}-toggle`;
    const daysId = `${field}-days`;
    return (
      <div key={field} className="space-y-4">
        <div className="flex items-center justify-between">
          <Label htmlFor={toggleId}>{t(`${labelKey}Enabled`)}</Label>
          <Switch
            id={toggleId}
            checked={generic.enabled[field]}
            onCheckedChange={(checked) => setGenericEnabled(field, checked)}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t(`${labelKey}EnabledHelp`)}</p>

        {generic.enabled[field] && (
          <div className="space-y-2">
            <Label htmlFor={daysId}>{t(`${labelKey}Days`)}</Label>
            <Input
              id={daysId}
              type="number"
              min={RETENTION_DAYS_MIN}
              max={RETENTION_DAYS_MAX}
              value={generic.days[field]}
              {...bindRangeInput((value) => setGenericDays(field, value), {
                min: RETENTION_DAYS_MIN,
                max: RETENTION_DAYS_MAX,
                onEdit: () => setError(null),
              })}
              placeholder="30"
            />
            <p className="text-xs text-muted-foreground">{t(`${labelKey}DaysHelp`, { min: RETENTION_DAYS_MIN, max: RETENTION_DAYS_MAX })}</p>
          </div>
        )}
      </div>
    );
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
      <SectionCardHeader icon={Archive} title={t("retentionPolicyTitle")} description={t("retentionPolicyDescription")} />
      <CardContent className="space-y-6">
        {/* Vault data retention */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium">{t("retentionVaultDataHeading")}</h3>
          {VAULT_DATA_KEYS.map(renderGenericField)}
        </div>

        {/* Log retention */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium">{t("retentionLogsHeading")}</h3>
          {LOG_KEYS.map(renderGenericField)}

          {/* Audit log retention (stricter forensic floor) */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="audit-log-retention-toggle">{t("auditLogRetentionEnabled")}</Label>
              <Switch
                id="audit-log-retention-toggle"
                checked={auditLogRetentionEnabled}
                onCheckedChange={(checked) => {
                  setAuditLogRetentionEnabled(checked);
                  setError(null);
                  if (!checked) setAuditLogRetentionDays("");
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">{t("auditLogRetentionEnabledHelp")}</p>

            {auditLogRetentionEnabled && (
              <div className="space-y-2">
                <Label htmlFor="audit-log-retention-days">{t("auditLogRetentionDays")}</Label>
                <Input
                  id="audit-log-retention-days"
                  type="number"
                  min={AUDIT_LOG_RETENTION_MIN}
                  max={AUDIT_LOG_RETENTION_MAX}
                  value={auditLogRetentionDays}
                  {...bindRangeInput(setAuditLogRetentionDays, {
                    min: AUDIT_LOG_RETENTION_MIN,
                    max: AUDIT_LOG_RETENTION_MAX,
                    onEdit: () => setError(null),
                  })}
                  placeholder="365"
                />
                <p className="text-xs text-muted-foreground">{t("auditLogRetentionDaysHelp", { min: AUDIT_LOG_RETENTION_MIN, max: AUDIT_LOG_RETENTION_MAX })}</p>
              </div>
            )}
          </div>
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
            {t("retentionPolicySave")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
