"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Shield, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

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
};

interface TeamPolicySettingsProps {
  teamId: string;
}

export function TeamPolicySettings({ teamId }: TeamPolicySettingsProps) {
  const t = useTranslations("TeamPolicy");
  const [policy, setPolicy] = useState<PolicyData>(DEFAULT_POLICY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await fetch(`/api/teams/${teamId}/policy`);
      if (res.ok) {
        setPolicy(await res.json());
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

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/teams/${teamId}/policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(policy),
      });
      if (res.ok) {
        setPolicy(await res.json());
        toast.success(t("saveSuccess"));
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
      <Card className="rounded-xl border bg-card/80 p-4">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl border bg-card/80 p-4">
      <section className="space-y-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Shield className="h-5 w-5 text-muted-foreground" />
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("minPasswordLength")}</Label>
            <Input
              type="number"
              min={0}
              max={128}
              value={policy.minPasswordLength}
              onChange={(e) =>
                setPolicy((p) => ({
                  ...p,
                  minPasswordLength: parseInt(e.target.value, 10) || 0,
                }))
              }
              className="max-w-[200px]"
            />
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

          <div className="space-y-2">
            <Label>{t("maxSessionDurationMinutes")}</Label>
            <Input
              type="number"
              min={5}
              max={43200}
              value={policy.maxSessionDurationMinutes ?? ""}
              onChange={(e) =>
                setPolicy((p) => ({
                  ...p,
                  maxSessionDurationMinutes: e.target.value
                    ? parseInt(e.target.value, 10)
                    : null,
                }))
              }
              placeholder={t("maxSessionDurationHelp")}
              className="max-w-[200px]"
            />
          </div>

          <SwitchField
            label={t("requireRepromptForAll")}
            checked={policy.requireRepromptForAll}
            onChange={(v) =>
              setPolicy((p) => ({ ...p, requireRepromptForAll: v }))
            }
          />

          <SwitchField
            label={t("allowExport")}
            checked={policy.allowExport}
            onChange={(v) => setPolicy((p) => ({ ...p, allowExport: v }))}
          />

          <SwitchField
            label={t("allowSharing")}
            checked={policy.allowSharing}
            onChange={(v) => setPolicy((p) => ({ ...p, allowSharing: v }))}
          />
        </div>

        <div className="flex justify-end pt-1">
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {saving ? t("saving") : t("save")}
          </Button>
        </div>
      </section>
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
    <div className="flex items-center justify-between gap-2 rounded-lg border p-3">
      <Label className="cursor-pointer">{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
