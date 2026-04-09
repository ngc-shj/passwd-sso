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
import { SectionCardHeader } from "@/components/settings/section-card-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { useFormDirty } from "@/hooks/use-form-dirty";
import { useBeforeUnloadGuard } from "@/hooks/use-before-unload-guard";
import { FormDirtyBadge } from "@/components/settings/form-dirty-badge";

export function TenantRetentionPolicyCard() {
  const t = useTranslations("TenantAdmin");
  const tCommon = useTranslations("Common");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [auditLogRetentionEnabled, setAuditLogRetentionEnabled] = useState(false);
  const [auditLogRetentionDays, setAuditLogRetentionDays] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [initialPolicy, setInitialPolicy] = useState<Record<string, unknown> | null>(null);

  const currentPolicy = useMemo(() => ({
    auditLogRetentionEnabled,
    auditLogRetentionDays,
  }), [auditLogRetentionEnabled, auditLogRetentionDays]);

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

        setInitialPolicy({
          auditLogRetentionEnabled: retentionEnabled,
          auditLogRetentionDays: retentionStr,
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

  const validate = (): string | null => {
    if (auditLogRetentionEnabled) {
      if (auditLogRetentionDays === "") return t("auditLogRetentionRequired");
      const num = Number(auditLogRetentionDays);
      if (!Number.isInteger(num) || num < 30) return t("auditLogRetentionValidationMin");
      if (num > 3650) return t("auditLogRetentionValidationMax");
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
        auditLogRetentionDays: auditLogRetentionEnabled ? Number(auditLogRetentionDays) : null,
      };
      const res = await fetchApi(API_PATH.TENANT_POLICY, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(t("retentionPolicySaved"));
        setInitialPolicy({ ...currentPolicy });
      } else {
        toast.error(t("retentionPolicySaveFailed"));
      }
    } catch {
      toast.error(t("retentionPolicySaveFailed"));
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
      <SectionCardHeader icon={Archive} title={t("retentionPolicyTitle")} description={t("retentionPolicyDescription")} />
      <CardContent className="space-y-4">
        {/* Audit log retention */}
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
              min={30}
              max={3650}
              value={auditLogRetentionDays}
              onChange={(e) => {
                const raw = e.target.value;
                if (!raw) { setAuditLogRetentionDays(""); } else {
                  const n = parseInt(raw, 10);
                  if (Number.isNaN(n) || n < 30) { setAuditLogRetentionDays(""); } else {
                    setAuditLogRetentionDays(String(Math.min(n, 3650)));
                  }
                }
                setError(null);
              }}
              placeholder="365"
            />
            <p className="text-xs text-muted-foreground">{t("auditLogRetentionDaysHelp")}</p>
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
            {t("retentionPolicySave")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
