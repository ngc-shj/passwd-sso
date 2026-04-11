"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ShieldAlert, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/section-card-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import {
  LOCKOUT_THRESHOLD_MIN,
  LOCKOUT_THRESHOLD_MAX,
  LOCKOUT_DURATION_MIN,
  LOCKOUT_DURATION_MAX,
} from "@/lib/validations";
import { useFormDirty } from "@/hooks/use-form-dirty";
import { useBeforeUnloadGuard } from "@/hooks/use-before-unload-guard";
import { FormDirtyBadge } from "@/components/settings/form-dirty-badge";

export function TenantLockoutPolicyCard() {
  const t = useTranslations("TenantAdmin");
  const tCommon = useTranslations("Common");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [threshold1, setThreshold1] = useState<string>("");
  const [duration1, setDuration1] = useState<string>("");
  const [threshold2, setThreshold2] = useState<string>("");
  const [duration2, setDuration2] = useState<string>("");
  const [threshold3, setThreshold3] = useState<string>("");
  const [duration3, setDuration3] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [initialPolicy, setInitialPolicy] = useState<Record<string, unknown> | null>(null);

  const currentPolicy = useMemo(() => ({
    threshold1,
    duration1,
    threshold2,
    duration2,
    threshold3,
    duration3,
  }), [threshold1, duration1, threshold2, duration2, threshold3, duration3]);

  const hasChanges = useFormDirty(currentPolicy, initialPolicy);
  useBeforeUnloadGuard(hasChanges);

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.TENANT_POLICY);
      if (res.ok) {
        const data = await res.json();

        const t1 = data.lockoutThreshold1 !== null && data.lockoutThreshold1 !== undefined ? String(data.lockoutThreshold1) : "";
        const d1 = data.lockoutDuration1Minutes !== null && data.lockoutDuration1Minutes !== undefined ? String(data.lockoutDuration1Minutes) : "";
        const t2 = data.lockoutThreshold2 !== null && data.lockoutThreshold2 !== undefined ? String(data.lockoutThreshold2) : "";
        const d2 = data.lockoutDuration2Minutes !== null && data.lockoutDuration2Minutes !== undefined ? String(data.lockoutDuration2Minutes) : "";
        const t3 = data.lockoutThreshold3 !== null && data.lockoutThreshold3 !== undefined ? String(data.lockoutThreshold3) : "";
        const d3 = data.lockoutDuration3Minutes !== null && data.lockoutDuration3Minutes !== undefined ? String(data.lockoutDuration3Minutes) : "";

        setThreshold1(t1);
        setDuration1(d1);
        setThreshold2(t2);
        setDuration2(d2);
        setThreshold3(t3);
        setDuration3(d3);

        setInitialPolicy({ threshold1: t1, duration1: d1, threshold2: t2, duration2: d2, threshold3: t3, duration3: d3 });
      } else {
        toast.error(t("lockoutPolicyLoadFailed"));
      }
    } catch {
      toast.error(t("lockoutPolicyLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchPolicy();
  }, [fetchPolicy]);

  const validate = (): string | null => {
    const t1 = threshold1 !== "" ? Number(threshold1) : null;
    const d1 = duration1 !== "" ? Number(duration1) : null;
    const t2 = threshold2 !== "" ? Number(threshold2) : null;
    const d2 = duration2 !== "" ? Number(duration2) : null;
    const t3 = threshold3 !== "" ? Number(threshold3) : null;
    const d3 = duration3 !== "" ? Number(duration3) : null;

    if (t1 !== null && (t1 < LOCKOUT_THRESHOLD_MIN || t1 > LOCKOUT_THRESHOLD_MAX)) return t("lockoutThresholdRange");
    if (d1 !== null && (d1 < LOCKOUT_DURATION_MIN || d1 > LOCKOUT_DURATION_MAX)) return t("lockoutDurationRange");
    if (t2 !== null && (t2 < LOCKOUT_THRESHOLD_MIN || t2 > LOCKOUT_THRESHOLD_MAX)) return t("lockoutThresholdRange");
    if (d2 !== null && (d2 < LOCKOUT_DURATION_MIN || d2 > LOCKOUT_DURATION_MAX)) return t("lockoutDurationRange");
    if (t3 !== null && (t3 < LOCKOUT_THRESHOLD_MIN || t3 > LOCKOUT_THRESHOLD_MAX)) return t("lockoutThresholdRange");
    if (d3 !== null && (d3 < LOCKOUT_DURATION_MIN || d3 > LOCKOUT_DURATION_MAX)) return t("lockoutDurationRange");

    // Thresholds must be ascending
    if (t1 !== null && t2 !== null && t2 <= t1) return t("lockoutThresholdAscending");
    if (t2 !== null && t3 !== null && t3 <= t2) return t("lockoutThresholdAscending");

    // Durations must be ascending
    if (d1 !== null && d2 !== null && d2 <= d1) return t("lockoutDurationAscending");
    if (d2 !== null && d3 !== null && d3 <= d2) return t("lockoutDurationAscending");

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
        lockoutThreshold1: threshold1 !== "" ? Number(threshold1) : null,
        lockoutDuration1Minutes: duration1 !== "" ? Number(duration1) : null,
        lockoutThreshold2: threshold2 !== "" ? Number(threshold2) : null,
        lockoutDuration2Minutes: duration2 !== "" ? Number(duration2) : null,
        lockoutThreshold3: threshold3 !== "" ? Number(threshold3) : null,
        lockoutDuration3Minutes: duration3 !== "" ? Number(duration3) : null,
      };
      const res = await fetchApi(API_PATH.TENANT_POLICY, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(t("lockoutPolicySaved"));
        setInitialPolicy({ ...currentPolicy });
      } else {
        toast.error(t("lockoutPolicySaveFailed"));
      }
    } catch {
      toast.error(t("lockoutPolicySaveFailed"));
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

  const tierFields = [
    { tier: 1, threshold: threshold1, duration: duration1, setThreshold: setThreshold1, setDuration: setDuration1 },
    { tier: 2, threshold: threshold2, duration: duration2, setThreshold: setThreshold2, setDuration: setDuration2 },
    { tier: 3, threshold: threshold3, duration: duration3, setThreshold: setThreshold3, setDuration: setDuration3 },
  ];

  return (
    <Card>
      <SectionCardHeader icon={ShieldAlert} title={t("lockoutPolicyTitle")} description={t("lockoutPolicyDescription")} />
      <CardContent className="space-y-4">
        {tierFields.map(({ tier, threshold, duration, setThreshold, setDuration }, idx) => (
          <div key={tier}>
            {idx > 0 && <Separator className="mb-4" />}
            <p className="text-sm font-medium mb-3">{t("lockoutTierLabel", { tier })}</p>
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor={`lockout-threshold-${tier}`}>{t("lockoutThresholdLabel")}</Label>
                <Input
                  id={`lockout-threshold-${tier}`}
                  type="number"
                  min={LOCKOUT_THRESHOLD_MIN}
                  max={LOCKOUT_THRESHOLD_MAX}
                  value={threshold}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (!raw) { setThreshold(""); } else {
                      const n = parseInt(raw, 10);
                      if (Number.isNaN(n) || n < LOCKOUT_THRESHOLD_MIN) { setThreshold(""); } else {
                        setThreshold(String(Math.min(n, LOCKOUT_THRESHOLD_MAX)));
                      }
                    }
                    setError(null);
                  }}
                  placeholder="5"
                />
                <p className="text-xs text-muted-foreground">{t("lockoutThresholdHelp")}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`lockout-duration-${tier}`}>{t("lockoutDurationLabel")}</Label>
                <Input
                  id={`lockout-duration-${tier}`}
                  type="number"
                  min={LOCKOUT_DURATION_MIN}
                  max={LOCKOUT_DURATION_MAX}
                  value={duration}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (!raw) { setDuration(""); } else {
                      const n = parseInt(raw, 10);
                      if (Number.isNaN(n) || n < LOCKOUT_DURATION_MIN) { setDuration(""); } else {
                        setDuration(String(Math.min(n, LOCKOUT_DURATION_MAX)));
                      }
                    }
                    setError(null);
                  }}
                  placeholder="15"
                />
                <p className="text-xs text-muted-foreground">{t("lockoutDurationHelp")}</p>
              </div>
            </div>
          </div>
        ))}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center justify-between">
          <FormDirtyBadge
            hasChanges={hasChanges}
            unsavedLabel={tCommon("statusUnsaved")}
            savedLabel={tCommon("statusSaved")}
          />
          <Button onClick={handleSave} disabled={saving || !hasChanges}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("lockoutPolicySave")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
