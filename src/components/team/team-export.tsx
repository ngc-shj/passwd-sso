"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { encryptExport } from "@/lib/export-crypto";
import { PagePane } from "@/components/layout/page-pane";
import { PageTitleCard } from "@/components/layout/page-title-card";
import { ExportOptionsPanel } from "@/components/passwords/export-options-panel";
import { AlertTriangle, Building2 } from "lucide-react";
import { API_PATH, apiPath } from "@/lib/constants";
import { ENTRY_TYPE } from "@/lib/constants";
import {
  type ExportFormat,
  type ExportEntry,
  TEAM_EXPORT_OPTIONS,
  type ExportProfile,
  formatExportContent as formatExportContentShared,
  formatExportDate,
} from "@/lib/export-format-common";
import { useTeamVault } from "@/lib/team-vault-context";
import { decryptData } from "@/lib/crypto-client";
import { buildTeamEntryAAD } from "@/lib/crypto-aad";

interface TeamExportPanelContentProps {
  teamId?: string;
}

function TeamExportPanelContent({ teamId: scopedTeamId }: TeamExportPanelContentProps) {
  if (!scopedTeamId) return null;
  const t = useTranslations("Export");
  const { getTeamEncryptionKey } = useTeamVault();
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
      // Fetch list of all team passwords (overview only)
      const listRes = await fetch(apiPath.teamPasswords(scopedTeamId));
      if (!listRes.ok) throw new Error("Failed to fetch list");
      const list: { id: string; entryType: string }[] = await listRes.json();

      // Get team encryption key for decryption
      const teamKey = await getTeamEncryptionKey(scopedTeamId);
      if (!teamKey) throw new Error("No team key");

      // Fetch full details for each entry and decrypt
      const entries: ExportEntry[] = [];
      let skippedCount = 0;
      for (const item of list) {
        try {
          const res = await fetch(apiPath.teamPasswordById(scopedTeamId, item.id));
          if (!res.ok) {
            skippedCount++;
            continue;
          }
          const raw = await res.json();

          // Decrypt the blob
          const aad = buildTeamEntryAAD(scopedTeamId, raw.id, "blob");
          const json = await decryptData(
            {
              ciphertext: raw.encryptedBlob,
              iv: raw.blobIv,
              authTag: raw.blobAuthTag,
            },
            teamKey,
            aad,
          );
          const data = JSON.parse(json);

          entries.push({
            entryType: raw.entryType ?? ENTRY_TYPE.LOGIN,
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
            tags: Array.isArray(raw.tags) ? raw.tags : [],
            customFields: Array.isArray(data.customFields) ? data.customFields : [],
            totpConfig: data.totp ?? null,
            generatorSettings: data.generatorSettings ?? null,
            passwordHistory: Array.isArray(data.passwordHistory) ? data.passwordHistory : [],
          });
        } catch {
          skippedCount++;
        }
      }

      const content = formatExportContentShared(
        entries,
        format,
        exportProfile,
        TEAM_EXPORT_OPTIONS
      );

      let blob: Blob;
      let filename: string;

      if (passwordProtect) {
        const encrypted = await encryptExport(content, exportPassword, format);
        const encryptedJson = JSON.stringify(encrypted, null, 2);
        blob = new Blob([encryptedJson], { type: "application/json" });
        filename = `passwd-sso-team-export-${formatExportDate()}.encrypted.json`;
      } else {
        const mimeType = format === "csv" ? "text/csv;charset=utf-8" : "application/json";
        blob = new Blob([content], { type: mimeType });
        filename = `passwd-sso-team-export-${formatExportDate()}.${format}`;
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Async nonblocking audit log
      fetch(API_PATH.AUDIT_LOGS_EXPORT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId: scopedTeamId,
          entryCount: entries.length,
          format,
          filename,
          encrypted: passwordProtect,
          includeTeams: false,
        }),
      }).catch(() => {});

      if (skippedCount > 0) {
        toast.warning(t("exportSkipped", { count: String(skippedCount) }));
      }

      resetState();
    } catch {
      toast.error(t("exportFailed"));
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
          idPrefix="team-"
          showProtectTopBorder={false}
        />
    </>
  );

  return content;
}

interface TeamExportPagePanelProps {
  teamId?: string;
}

export function TeamExportPagePanel({ teamId }: TeamExportPagePanelProps) {
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
      <TeamExportPanelContent teamId={teamId} />
    </PagePane>
  );
}
