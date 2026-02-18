"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { encryptExport } from "@/lib/export-crypto";
import { PagePane } from "@/components/layout/page-pane";
import { PageTitleCard } from "@/components/layout/page-title-card";
import { ExportOptionsPanel } from "@/components/passwords/export-options-panel";
import { AlertTriangle, Building2 } from "lucide-react";
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
      <div className="flex items-start gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3">
          <AlertTriangle className="h-5 w-5 text-yellow-600 shrink-0 mt-0.5" />
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            {passwordProtect ? t("encryptedWarning") : t("warning")}
          </p>
        </div>

        <ExportOptionsPanel
          t={t}
          exportProfile={exportProfile}
          onExportProfileChange={setExportProfile}
          passwordProtect={passwordProtect}
          onPasswordProtectChange={(checked) => {
            setPasswordProtect(checked);
            setPasswordError("");
            if (!checked) {
              setExportPassword("");
              setConfirmPassword("");
            }
          }}
          exportPassword={exportPassword}
          onExportPasswordChange={(value) => {
            setExportPassword(value);
            setPasswordError("");
          }}
          confirmPassword={confirmPassword}
          onConfirmPasswordChange={(value) => {
            setConfirmPassword(value);
            setPasswordError("");
          }}
          passwordError={passwordError}
          exporting={exporting}
          onExport={handleExport}
          idPrefix="org-"
          showProtectTopBorder={false}
        />
    </>
  );

  return content;
}

interface OrgExportPagePanelProps {
  orgId: string;
}

export function OrgExportPagePanel({ orgId }: OrgExportPagePanelProps) {
  const t = useTranslations("Export");
  return (
    <PagePane
      header={
        <PageTitleCard
          icon={<Building2 className="h-5 w-5" />}
          title={t("title")}
          description={t("description")}
        />
      }
    >
      <OrgExportPanelContent orgId={orgId} />
    </PagePane>
  );
}
