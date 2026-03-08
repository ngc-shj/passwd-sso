"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Shield, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";

export function TenantSessionPolicyCard() {
  const t = useTranslations("TenantAdmin");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [unlimited, setUnlimited] = useState(true);
  const [maxSessions, setMaxSessions] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.TENANT_POLICY);
      if (res.ok) {
        const data = await res.json();
        const val = data.maxConcurrentSessions;
        if (val === null || val === undefined) {
          setUnlimited(true);
          setMaxSessions("");
        } else {
          setUnlimited(false);
          setMaxSessions(String(val));
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPolicy();
  }, [fetchPolicy]);

  const validate = (value: string): string | null => {
    if (unlimited) return null;
    const num = Number(value);
    if (!Number.isInteger(num) || num < 1) return t("sessionPolicyValidationMin");
    if (num > 100) return t("sessionPolicyValidationMax");
    return null;
  };

  const handleSave = async () => {
    const validationError = validate(maxSessions);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const body = {
        maxConcurrentSessions: unlimited ? null : Number(maxSessions),
      };
      const res = await fetchApi(API_PATH.TENANT_POLICY, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(t("sessionPolicySaved"));
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
      <CardHeader>
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5" />
          <CardTitle>{t("sessionPolicyTitle")}</CardTitle>
        </div>
        <CardDescription>{t("sessionPolicyDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
                setMaxSessions(e.target.value);
                setError(null);
              }}
              placeholder="e.g. 3"
            />
            <p className="text-xs text-muted-foreground">
              {t("maxConcurrentSessionsHelp")}
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("sessionPolicySave")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
