"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { encryptExport } from "@/lib/export-crypto";
import {
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Download, Loader2, AlertTriangle, Lock, Building2 } from "lucide-react";
import { API_PATH, apiPath } from "@/lib/constants";
import { ENTRY_TYPE } from "@/lib/constants";
import {
  type ExportEntry,
  ORG_EXPORT_OPTIONS,
  type ExportProfile,
  formatExportContent as formatExportContentShared,
  formatExportDate,
} from "@/lib/export-format-common";

interface OrgExportPanelContentProps {
  orgId: string;
}

function OrgExportPanelContent({ orgId }: OrgExportPanelContentProps) {
  const t = useTranslations("Export");
  const [exporting, setExporting] = useState(false);
  const [passwordProtect, setPasswordProtect] = useState(true);
  const [exportPassword, setExportPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [exportProfile, setExportProfile] = useState<ExportProfile>("compatible");

  const resetState = () => {
    setPasswordProtect(true);
    setExportPassword("");
    setConfirmPassword("");
    setPasswordError("");
    setExportProfile("compatible");
  };

  const validatePassword = (): boolean => {
    if (!passwordProtect) return true;
    if (exportPassword.length < 8) {
      setPasswordError(t("passwordTooShort"));
      return false;
    }
    if (exportPassword !== confirmPassword) {
      setPasswordError(t("passwordMismatch"));
      return false;
    }
    setPasswordError("");
    return true;
  };

  const handleExport = async (format: ExportFormat) => {
    if (!validatePassword()) return;
    setExporting(true);

    try {
      // Fetch list of all org passwords (overview only)
      const listRes = await fetch(apiPath.orgPasswords(orgId));
      if (!listRes.ok) throw new Error("Failed to fetch list");
      const list: { id: string; entryType: string }[] = await listRes.json();

      // Fetch full details for each entry
      const entries: ExportEntry[] = [];
      for (const item of list) {
        try {
          const res = await fetch(apiPath.orgPasswordById(orgId, item.id));
          if (!res.ok) continue;
          const data = await res.json();

          entries.push({
            entryType: data.entryType ?? ENTRY_TYPE.LOGIN,
            title: data.title ?? "",
            username: data.username ?? null,
            password: data.password ?? "",
            content: data.content ?? null,
            url: data.url ?? null,
            notes: data.notes ?? null,
            totp: data.totp?.secret ?? null,
            cardholderName: data.cardholderName ?? null,
            cardNumber: data.cardNumber ?? null,
            brand: data.brand ?? null,
            expiryMonth: data.expiryMonth ?? null,
            expiryYear: data.expiryYear ?? null,
            cvv: data.cvv ?? null,
            fullName: data.fullName ?? null,
            address: data.address ?? null,
            phone: data.phone ?? null,
            email: data.email ?? null,
            dateOfBirth: data.dateOfBirth ?? null,
            nationality: data.nationality ?? null,
            idNumber: data.idNumber ?? null,
            issueDate: data.issueDate ?? null,
            expiryDate: data.expiryDate ?? null,
            tags: Array.isArray(data.tags) ? data.tags : [],
            customFields: Array.isArray(data.customFields) ? data.customFields : [],
            totpConfig: data.totp ?? null,
            generatorSettings: data.generatorSettings ?? null,
            passwordHistory: Array.isArray(data.passwordHistory) ? data.passwordHistory : [],
          });
        } catch {
          // Skip entries that fail to fetch
        }
      }

      const content = formatExportContentShared(
        entries,
        format,
        exportProfile,
        ORG_EXPORT_OPTIONS
      );

      let blob: Blob;
      let filename: string;

      if (passwordProtect) {
        const encrypted = await encryptExport(content, exportPassword, format);
        const encryptedJson = JSON.stringify(encrypted, null, 2);
        blob = new Blob([encryptedJson], { type: "application/json" });
        filename = `passwd-sso-org-export-${formatExportDate()}.encrypted.json`;
      } else {
        const mimeType = format === "csv" ? "text/csv;charset=utf-8" : "application/json";
        blob = new Blob([content], { type: mimeType });
        filename = `passwd-sso-org-export-${formatExportDate()}.${format}`;
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Fire-and-forget audit log
      fetch(API_PATH.AUDIT_LOGS_EXPORT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId,
          entryCount: entries.length,
          format,
          filename,
          encrypted: passwordProtect,
          includeOrgs: false,
        }),
      }).catch(() => {});

      resetState();
    } catch {
      // Export failed silently
    } finally {
      setExporting(false);
    }
  };

  const content = (
    <>
      <div className="space-y-1.5">
        <h1 className="flex items-center gap-2 text-lg font-semibold leading-none tracking-tight">
          <Building2 className="h-4 w-4" />
          {t("title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

        <div className="flex items-start gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3">
          <AlertTriangle className="h-5 w-5 text-yellow-600 shrink-0 mt-0.5" />
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            {passwordProtect ? t("encryptedWarning") : t("warning")}
          </p>
        </div>

        <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
          <div className="space-y-1.5">
            <Label htmlFor="org-export-profile" className="text-sm font-medium">
              {t("profileLabel")}
            </Label>
            <select
              id="org-export-profile"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={exportProfile}
              onChange={(e) => setExportProfile(e.target.value as ExportProfile)}
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

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-muted-foreground" />
              <div>
                <Label htmlFor="org-password-protect" className="text-sm font-medium">
                  {t("passwordProtect")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("passwordProtectDesc")}
                </p>
              </div>
            </div>
            <Switch
              id="org-password-protect"
              checked={passwordProtect}
              onCheckedChange={(checked) => {
                setPasswordProtect(checked);
                setPasswordError("");
                if (!checked) {
                  setExportPassword("");
                  setConfirmPassword("");
                }
              }}
            />
          </div>

          {passwordProtect && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="org-export-password" className="text-sm">
                  {t("exportPassword")}
                </Label>
                <Input
                  id="org-export-password"
                  type="password"
                  value={exportPassword}
                  onChange={(e) => {
                    setExportPassword(e.target.value);
                    setPasswordError("");
                  }}
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="org-confirm-password" className="text-sm">
                  {t("confirmPassword")}
                </Label>
                <Input
                  id="org-confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    setPasswordError("");
                  }}
                  autoComplete="new-password"
                />
              </div>
              {passwordError && (
                <p className="text-sm text-destructive">{passwordError}</p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:justify-end sm:gap-2">
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => handleExport("csv")}
            disabled={exporting}
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
            onClick={() => handleExport("json")}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Download className="h-4 w-4 mr-2" />
            )}
            {t("exportJson")}
          </Button>
        </DialogFooter>
    </>
  );

  return content;
}

interface OrgExportPagePanelProps {
  orgId: string;
}

export function OrgExportPagePanel({ orgId }: OrgExportPagePanelProps) {
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
      <OrgExportPanelContent orgId={orgId} />
    </div>
  );
}
