"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ShieldBan, Loader2 } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { TAILNET_NAME_MAX_LENGTH, MAX_CIDRS } from "@/lib/validations";
import { useFormDirty } from "@/hooks/use-form-dirty";
import { useBeforeUnloadGuard } from "@/hooks/use-before-unload-guard";
import { FormDirtyBadge } from "@/components/settings/form-dirty-badge";

const CIDR_REGEX = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const CIDR_V6_REGEX = /^[0-9a-fA-F:]*:[0-9a-fA-F:]*\/\d{1,3}$/;

function isValidCidrFormat(cidr: string): boolean {
  return CIDR_REGEX.test(cidr) || CIDR_V6_REGEX.test(cidr);
}

export function TenantAccessRestrictionCard() {
  const t = useTranslations("TenantAdmin");
  const tCommon = useTranslations("Common");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cidrsText, setCidrsText] = useState("");
  const [tailscaleEnabled, setTailscaleEnabled] = useState(false);
  const [tailscaleTailnet, setTailscaleTailnet] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showLockoutDialog, setShowLockoutDialog] = useState(false);
  const [initialRestriction, setInitialRestriction] = useState<Record<string, unknown> | null>(null);

  const currentRestriction = useMemo(() => ({
    cidrsText,
    tailscaleEnabled,
    tailscaleTailnet,
  }), [cidrsText, tailscaleEnabled, tailscaleTailnet]);

  const hasChanges = useFormDirty(currentRestriction, initialRestriction);
  useBeforeUnloadGuard(hasChanges);

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.TENANT_POLICY);
      if (res.ok) {
        const data = await res.json();
        const cidrs: string[] = data.allowedCidrs ?? [];
        const cidrsVal = cidrs.join("\n");
        const tailscaleEnabledVal = data.tailscaleEnabled ?? false;
        const tailscaleTailnetVal = data.tailscaleTailnet ?? "";
        setCidrsText(cidrsVal);
        setTailscaleEnabled(tailscaleEnabledVal);
        setTailscaleTailnet(tailscaleTailnetVal);
        setInitialRestriction({
          cidrsText: cidrsVal,
          tailscaleEnabled: tailscaleEnabledVal,
          tailscaleTailnet: tailscaleTailnetVal,
        });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPolicy();
  }, [fetchPolicy]);

  const parseCidrs = (): string[] => {
    return cidrsText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  };

  const validate = (): string | null => {
    const cidrs = parseCidrs();
    if (cidrs.length > MAX_CIDRS) {
      return t("allowedCidrsValidationMax", { max: MAX_CIDRS });
    }
    for (const cidr of cidrs) {
      if (!isValidCidrFormat(cidr)) {
        return t("allowedCidrsValidationInvalid", { cidr });
      }
    }
    if (tailscaleEnabled && !tailscaleTailnet.trim()) {
      return t("tailscaleTailnetRequired");
    }
    return null;
  };

  const doSave = async (confirmLockout: boolean) => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const cidrs = parseCidrs();
      const body: Record<string, unknown> = {
        allowedCidrs: cidrs,
        tailscaleEnabled,
        tailscaleTailnet: tailscaleEnabled ? tailscaleTailnet.trim() : null,
      };
      if (confirmLockout) {
        body.confirmLockout = true;
      }
      const res = await fetchApi(API_PATH.TENANT_POLICY, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(t("accessRestrictionSaved"));
        setInitialRestriction({ ...currentRestriction });
        setShowLockoutDialog(false);
      } else {
        const data = await res.json().catch(() => null);
        if (res.status === 409 && data?.error === "SELF_LOCKOUT") {
          setShowLockoutDialog(true);
        } else {
          toast.error(t("accessRestrictionSaveFailed"));
        }
      }
    } catch {
      toast.error(t("accessRestrictionSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => doSave(false);
  const handleConfirmLockout = () => doSave(true);

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
    <>
      <Card>
        <SectionCardHeader icon={ShieldBan} title={t("accessRestrictionTitle")} description={t("accessRestrictionDescription")} />
        <CardContent className="space-y-4">
          {/* CIDR allowlist */}
          <div className="space-y-2">
            <Label htmlFor="allowed-cidrs">{t("allowedCidrsLabel")}</Label>
            <Textarea
              id="allowed-cidrs"
              rows={5}
              value={cidrsText}
              onChange={(e) => {
                setCidrsText(e.target.value);
                setError(null);
              }}
              placeholder={t("allowedCidrsPlaceholder")}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              {t("allowedCidrsHelp", { max: MAX_CIDRS })}
            </p>
          </div>

          <Separator />

          {/* Tailscale restriction */}
          <div className="flex items-center justify-between">
            <Label htmlFor="tailscale-toggle">{t("tailscaleEnabled")}</Label>
            <Switch
              id="tailscale-toggle"
              checked={tailscaleEnabled}
              onCheckedChange={(checked) => {
                setTailscaleEnabled(checked);
                setError(null);
                if (!checked) setTailscaleTailnet("");
              }}
            />
          </div>

          {tailscaleEnabled && (
            <div className="space-y-2">
              <Label htmlFor="tailscale-tailnet">{t("tailscaleTailnet")}</Label>
              <Input
                id="tailscale-tailnet"
                value={tailscaleTailnet}
                onChange={(e) => {
                  setTailscaleTailnet(e.target.value);
                  setError(null);
                }}
                placeholder={t("tailscaleTailnetPlaceholder")}
                maxLength={TAILNET_NAME_MAX_LENGTH}
              />
              <p className="text-xs text-muted-foreground">
                {t("tailscaleTailnetHelp")}
              </p>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {t("tailscaleEnabledHelp")}
          </p>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex items-center justify-between">
            <FormDirtyBadge
              hasChanges={hasChanges}
              unsavedLabel={tCommon("statusUnsaved")}
              savedLabel={tCommon("statusSaved")}
            />
            <Button onClick={handleSave} disabled={saving || !hasChanges}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("accessRestrictionSave")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Self-lockout confirmation dialog */}
      <AlertDialog open={showLockoutDialog} onOpenChange={setShowLockoutDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("accessRestrictionTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("selfLockoutWarning")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmLockout} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("selfLockoutConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
