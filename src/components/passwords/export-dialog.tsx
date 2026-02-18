"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD } from "@/lib/crypto-aad";
import { encryptExport } from "@/lib/export-crypto";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Download, Loader2, AlertTriangle, Lock, Building2 } from "lucide-react";
import { API_PATH, ENTRY_TYPE, apiPath } from "@/lib/constants";
import {
  type ExportEntry,
  type ExportProfile,
  csvEntryType,
  csvExportHeader,
  escapeCsvValue,
  formatExportJson,
  formatExportDate,
} from "@/lib/export-format-common";

type ExportFormat = "csv" | "json";

interface ExportDialogProps {
  trigger: React.ReactNode;
}

export function ExportDialog({ trigger }: ExportDialogProps) {
  const t = useTranslations("Export");
  const { encryptionKey, userId } = useVault();
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [passwordProtect, setPasswordProtect] = useState(true);
  const [exportPassword, setExportPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [includeOrgs, setIncludeOrgs] = useState(true);
  const [exportProfile, setExportProfile] = useState<ExportProfile>("compatible");

  const resetState = () => {
    setPasswordProtect(true);
    setExportPassword("");
    setConfirmPassword("");
    setPasswordError("");
    setIncludeOrgs(true);
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

      // 2. Fetch org entries (server-side decrypted via detail API)
      if (includeOrgs) try {
        const orgsRes = await fetch(API_PATH.ORGS);
        if (orgsRes.ok) {
          const orgs: { id: string }[] = await orgsRes.json();
          for (const org of orgs) {
            try {
              const listRes = await fetch(apiPath.orgPasswords(org.id));
              if (!listRes.ok) continue;
              const list: { id: string; entryType: string }[] = await listRes.json();
              for (const item of list) {
                try {
                  const detailRes = await fetch(apiPath.orgPasswordById(org.id, item.id));
                  if (!detailRes.ok) continue;
                  const data = await detailRes.json();
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
                    relyingPartyId: data.relyingPartyId ?? null,
                    relyingPartyName: data.relyingPartyName ?? null,
                    credentialId: data.credentialId ?? null,
                    creationDate: data.creationDate ?? null,
                    deviceInfo: data.deviceInfo ?? null,
                    tags: Array.isArray(data.tags) ? data.tags : [],
                    customFields: Array.isArray(data.customFields) ? data.customFields : [],
                    totpConfig: data.totp ?? null,
                    generatorSettings: data.generatorSettings ?? null,
                    passwordHistory: Array.isArray(data.passwordHistory) ? data.passwordHistory : [],
                    requireReprompt: false,
                  });
                } catch {
                  // Skip entries that fail to fetch
                }
              }
            } catch {
              // Skip orgs that fail to fetch
            }
          }
        }
      } catch {
        // Org fetch failed — continue with personal entries only
      }

      const content = formatExportContent(entries, format, exportProfile);

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
          includeOrgs,
        }),
      }).catch(() => {});

      setOpen(false);
      resetState();
    } catch {
      // Export failed silently
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) resetState();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-4 w-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

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

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              <div>
                <Label htmlFor="include-orgs" className="text-sm font-medium">
                  {t("includeOrgs")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("includeOrgsDesc")}
                </p>
              </div>
            </div>
            <Switch
              id="include-orgs"
              checked={includeOrgs}
              onCheckedChange={setIncludeOrgs}
            />
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
      </DialogContent>
    </Dialog>
  );
}

// ─── Formatting helpers ─────────────────────────────────────

function formatExportContent(
  entries: ExportEntry[],
  format: ExportFormat,
  profile: ExportProfile
): string {
  if (format === "csv") {
    return formatCsv(entries, profile);
  }
  return formatJson(entries, profile);
}

function formatCsv(entries: ExportEntry[], profile: ExportProfile): string {
  const header = csvExportHeader(profile === "passwd-sso");
  const rows = entries.map((e) => {
    const isNote = e.entryType === ENTRY_TYPE.SECURE_NOTE;
    const isCard = e.entryType === ENTRY_TYPE.CREDIT_CARD;
    const isIdentity = e.entryType === ENTRY_TYPE.IDENTITY;
    const isPasskey = e.entryType === ENTRY_TYPE.PASSKEY;
    const type = csvEntryType(e.entryType, { includePasskeyType: true });
    const isLogin = !isNote && !isCard && !isIdentity && !isPasskey;
    const passwdSso = JSON.stringify({
      entryType: e.entryType,
      tags: e.tags,
      customFields: e.customFields,
      totp: e.totpConfig,
      generatorSettings: e.generatorSettings,
      passwordHistory: e.passwordHistory,
      cardholderName: e.cardholderName,
      cardNumber: e.cardNumber,
      brand: e.brand,
      expiryMonth: e.expiryMonth,
      expiryYear: e.expiryYear,
      cvv: e.cvv,
      fullName: e.fullName,
      address: e.address,
      phone: e.phone,
      email: e.email,
      dateOfBirth: e.dateOfBirth,
      nationality: e.nationality,
      idNumber: e.idNumber,
      issueDate: e.issueDate,
      expiryDate: e.expiryDate,
      relyingPartyId: e.relyingPartyId,
      relyingPartyName: e.relyingPartyName,
      credentialId: e.credentialId,
      creationDate: e.creationDate,
      deviceInfo: e.deviceInfo,
    });
    return [
      "", // folder
      "", // favorite
      type,
      escapeCsvValue(e.title),
      escapeCsvValue(isNote ? e.content : e.notes),
      "", // fields
      e.requireReprompt ? "1" : "",
      isLogin ? escapeCsvValue(e.url) : "",
      isLogin ? escapeCsvValue(e.username) : "",
      isLogin ? escapeCsvValue(e.password) : "",
      isLogin ? escapeCsvValue(e.totp) : "",
      ...(profile === "passwd-sso" ? [escapeCsvValue(passwdSso)] : []),
    ].join(",");
  });
  return [header, ...rows].join("\n");
}

function formatJson(entries: ExportEntry[], profile: ExportProfile): string {
  return formatExportJson(entries, profile, {
    includePasskey: true,
    includeReprompt: true,
    includeRequireRepromptInPasswdSso: true,
  });
}

export const __testablesPersonalExport = {
  formatExportContent,
  formatCsv,
  formatJson,
};
