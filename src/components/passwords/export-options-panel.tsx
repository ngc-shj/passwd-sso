"use client";

import { Lock, Download, Loader2 } from "lucide-react";
import type { ExportFormat, ExportProfile } from "@/lib/export-format-common";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

interface ExportOptionsPanelProps {
  t: (key: string) => string;
  exportProfile: ExportProfile;
  onExportProfileChange: (profile: ExportProfile) => void;
  passwordProtect: boolean;
  onPasswordProtectChange: (checked: boolean) => void;
  exportPassword: string;
  onExportPasswordChange: (value: string) => void;
  confirmPassword: string;
  onConfirmPasswordChange: (value: string) => void;
  passwordError: string;
  exporting: boolean;
  onExport: (format: ExportFormat) => void;
  idPrefix?: string;
  showProtectTopBorder?: boolean;
}

export function ExportOptionsPanel({
  t,
  exportProfile,
  onExportProfileChange,
  passwordProtect,
  onPasswordProtectChange,
  exportPassword,
  onExportPasswordChange,
  confirmPassword,
  onConfirmPasswordChange,
  passwordError,
  exporting,
  onExport,
  idPrefix = "",
  showProtectTopBorder = true,
}: ExportOptionsPanelProps) {
  const profileId = `${idPrefix}export-profile`;
  const protectId = `${idPrefix}password-protect`;
  const exportPasswordId = `${idPrefix}export-password`;
  const confirmPasswordId = `${idPrefix}confirm-password`;
  const hasPasswordInputs = exportPassword.trim().length > 0 && confirmPassword.trim().length > 0;
  const passwordsMatch = exportPassword === confirmPassword;
  const exportButtonsDisabled = exporting || (
    passwordProtect && (
      !hasPasswordInputs || !passwordsMatch
    )
  );

  return (
    <>
      <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
        <div className="space-y-1.5">
          <Label htmlFor={profileId} className="text-sm font-medium">
            {t("profileLabel")}
          </Label>
          <select
            id={profileId}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={exportProfile}
            onChange={(e) => onExportProfileChange(e.target.value as ExportProfile)}
          >
            <option value="compatible">{t("profileCompatible")}</option>
            <option value="passwd-sso">{t("profilePasswdSso")}</option>
          </select>
          <p className="text-xs text-muted-foreground">
            {exportProfile === "compatible"
              ? t("profileCompatibleDesc")
              : t("profilePasswdSsoDesc")}
          </p>
        </div>

        <div
          className={`flex items-center justify-between ${
            showProtectTopBorder ? "border-t pt-3" : ""
          }`}
        >
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-muted-foreground" />
            <div>
              <Label htmlFor={protectId} className="text-sm font-medium">
                {t("passwordProtect")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("passwordProtectDesc")}
              </p>
            </div>
          </div>
          <Switch
            id={protectId}
            checked={passwordProtect}
            onCheckedChange={onPasswordProtectChange}
          />
        </div>

        {passwordProtect && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={exportPasswordId} className="text-sm">
                {t("exportPassword")}
              </Label>
              <Input
                id={exportPasswordId}
                type="password"
                value={exportPassword}
                onChange={(e) => onExportPasswordChange(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={confirmPasswordId} className="text-sm">
                {t("confirmPassword")}
              </Label>
              <Input
                id={confirmPasswordId}
                type="password"
                value={confirmPassword}
                onChange={(e) => onConfirmPasswordChange(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            {passwordError && (
              <p className="text-sm text-destructive">{passwordError}</p>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:justify-end sm:gap-2">
        <Button
          variant="outline"
          className="w-full sm:w-auto"
          onClick={() => onExport("csv")}
          disabled={exportButtonsDisabled}
        >
          {exporting ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          {t("exportCsv")}
        </Button>
        <Button
          className="w-full sm:w-auto"
          onClick={() => onExport("json")}
          disabled={exportButtonsDisabled}
        >
          {exporting ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          {t("exportJson")}
        </Button>
      </div>
    </>
  );
}
