"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD } from "@/lib/crypto-aad";
import { encryptExport } from "@/lib/export-crypto";
import {
  DialogFooter,
} from "@/components/ui/dialog";
import { PagePane } from "@/components/layout/page-pane";
import { PageTitleCard } from "@/components/layout/page-title-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Download, Loader2, AlertTriangle, Lock } from "lucide-react";
import { API_PATH, ENTRY_TYPE } from "@/lib/constants";
import {
  type ExportEntry,
  PERSONAL_EXPORT_OPTIONS,
  type ExportProfile,
  formatExportContent as formatExportContentShared,
  formatExportDate,
} from "@/lib/export-format-common";

function ExportPanelContent() {
  const t = useTranslations("Export");
  const { encryptionKey, userId } = useVault();
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
    if (!encryptionKey) return;
    if (!validatePassword()) return;
    setExporting(true);

    try {
      // 1. Fetch personal entries (E2E encrypted, decrypt client-side)
      const res = await fetch(`${API_PATH.PASSWORDS}?include=blob`);
      if (!res.ok) throw new Error("Failed to fetch");
      const rawEntries = await res.json();

      const entries: ExportEntry[] = [];
      for (const raw of rawEntries) {
        if (!raw.encryptedBlob) continue;
        try {
          const aad = raw.aadVersion >= 1 && userId
            ? buildPersonalEntryAAD(userId, raw.id)
            : undefined;
          const plaintext = await decryptData(
            raw.encryptedBlob as EncryptedData,
            encryptionKey,
            aad
          );
          const parsed = JSON.parse(plaintext);
          entries.push({
            entryType: raw.entryType ?? ENTRY_TYPE.LOGIN,
            title: parsed.title ?? "",
            username: parsed.username ?? null,
            password: parsed.password ?? "",
            content: parsed.content ?? null,
            url: parsed.url ?? null,
            notes: parsed.notes ?? null,
            totp: parsed.totp?.secret ?? null,
            cardholderName: parsed.cardholderName ?? null,
            cardNumber: parsed.cardNumber ?? null,
            brand: parsed.brand ?? null,
            expiryMonth: parsed.expiryMonth ?? null,
            expiryYear: parsed.expiryYear ?? null,
            cvv: parsed.cvv ?? null,
            fullName: parsed.fullName ?? null,
            address: parsed.address ?? null,
            phone: parsed.phone ?? null,
            email: parsed.email ?? null,
            dateOfBirth: parsed.dateOfBirth ?? null,
            nationality: parsed.nationality ?? null,
            idNumber: parsed.idNumber ?? null,
            issueDate: parsed.issueDate ?? null,
            expiryDate: parsed.expiryDate ?? null,
            relyingPartyId: parsed.relyingPartyId ?? null,
            relyingPartyName: parsed.relyingPartyName ?? null,
            credentialId: parsed.credentialId ?? null,
            creationDate: parsed.creationDate ?? null,
            deviceInfo: parsed.deviceInfo ?? null,
            tags: Array.isArray(parsed.tags) ? parsed.tags : [],
            customFields: Array.isArray(parsed.customFields) ? parsed.customFields : [],
            totpConfig: parsed.totp ?? null,
            generatorSettings: parsed.generatorSettings ?? null,
            passwordHistory: Array.isArray(parsed.passwordHistory) ? parsed.passwordHistory : [],
            requireReprompt: raw.requireReprompt ?? false,
          });
        } catch {
          // Skip entries that fail to decrypt
        }
      }

      const content = formatExportContentShared(
        entries,
        format,
        exportProfile,
        PERSONAL_EXPORT_OPTIONS
      );

      let blob: Blob;
      let filename: string;

      if (passwordProtect) {
        const encrypted = await encryptExport(content, exportPassword, format);
        const encryptedJson = JSON.stringify(encrypted, null, 2);
        blob = new Blob([encryptedJson], { type: "application/json" });
        filename = `passwd-sso-export-${formatExportDate()}.encrypted.json`;
      } else {
        const mimeType = format === "csv" ? "text/csv;charset=utf-8" : "application/json";
        blob = new Blob([content], { type: mimeType });
        filename = `passwd-sso-export-${formatExportDate()}.${format}`;
      }

      // Trigger download
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
      <div className="flex items-start gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3">
        <AlertTriangle className="h-5 w-5 text-yellow-600 shrink-0 mt-0.5" />
        <p className="text-sm text-yellow-800 dark:text-yellow-200">
          {passwordProtect ? t("encryptedWarning") : t("warning")}
        </p>
      </div>

      <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
        <div className="space-y-1.5">
          <Label htmlFor="export-profile" className="text-sm font-medium">
            {t("profileLabel")}
          </Label>
          <select
            id="export-profile"
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

        <div className="flex items-center justify-between border-t pt-3">
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-muted-foreground" />
              <div>
                <Label htmlFor="password-protect" className="text-sm font-medium">
                  {t("passwordProtect")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("passwordProtectDesc")}
                </p>
              </div>
            </div>
            <Switch
              id="password-protect"
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
                <Label htmlFor="export-password" className="text-sm">
                  {t("exportPassword")}
                </Label>
                <Input
                  id="export-password"
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
                <Label htmlFor="confirm-password" className="text-sm">
                  {t("confirmPassword")}
                </Label>
                <Input
                  id="confirm-password"
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

export function ExportPagePanel() {
  const t = useTranslations("Export");
  return (
    <PagePane
      header={
        <PageTitleCard
          icon={<Download className="h-5 w-5" />}
          title={t("title")}
          description={t("description")}
        />
      }
    >
      <ExportPanelContent />
    </PagePane>
  );
}
