"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
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
import { Download, Loader2, AlertTriangle, Lock } from "lucide-react";
import { API_PATH, apiPath } from "@/lib/constants";
import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";

type ExportFormat = "csv" | "json";

interface OrgExportEntry {
  entryType: EntryTypeValue;
  title: string;
  username: string | null;
  password: string;
  content: string | null;
  url: string | null;
  notes: string | null;
  totp: string | null;
  cardholderName: string | null;
  cardNumber: string | null;
  brand: string | null;
  expiryMonth: string | null;
  expiryYear: string | null;
  cvv: string | null;
  fullName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  dateOfBirth: string | null;
  nationality: string | null;
  idNumber: string | null;
  issueDate: string | null;
  expiryDate: string | null;
}

interface OrgExportDialogProps {
  orgId: string;
  trigger: React.ReactNode;
}

export function OrgExportDialog({ orgId, trigger }: OrgExportDialogProps) {
  const t = useTranslations("Export");
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [passwordProtect, setPasswordProtect] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");

  const resetState = () => {
    setPasswordProtect(false);
    setExportPassword("");
    setConfirmPassword("");
    setPasswordError("");
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
      const entries: OrgExportEntry[] = [];
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
          });
        } catch {
          // Skip entries that fail to fetch
        }
      }

      const content = formatExportContent(entries, format);

      let blob: Blob;
      let filename: string;

      if (passwordProtect) {
        const encrypted = await encryptExport(content, exportPassword, format);
        const encryptedJson = JSON.stringify(encrypted, null, 2);
        blob = new Blob([encryptedJson], { type: "application/json" });
        filename = `passwd-sso-org-export-${formatDate()}.encrypted.json`;
      } else {
        const mimeType = format === "csv" ? "text/csv;charset=utf-8" : "application/json";
        blob = new Blob([content], { type: mimeType });
        filename = `passwd-sso-org-export-${formatDate()}.${format}`;
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
        body: JSON.stringify({ orgId, entryCount: entries.length, format }),
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
          <AlertTriangle className="h-5 w-5 text-yellow-600 shrink-0 mt-0.5" />
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            {passwordProtect ? t("encryptedWarning") : t("warning")}
          </p>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-muted-foreground" />
              <Label htmlFor="org-password-protect" className="text-sm font-medium">
                {t("passwordProtect")}
              </Label>
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
            <p className="text-xs text-muted-foreground">
              {t("passwordProtectDesc")}
            </p>
          )}

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

        <DialogFooter className="flex gap-2 sm:gap-2">
          <Button
            variant="outline"
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
            variant="outline"
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

function formatExportContent(entries: OrgExportEntry[], format: ExportFormat): string {
  if (format === "csv") {
    return formatCsv(entries);
  }
  return formatJson(entries);
}

function formatCsv(entries: OrgExportEntry[]): string {
  const header =
    "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp";
  const escapeCsv = (val: string | null) => {
    if (!val) return "";
    if (val.includes(",") || val.includes('"') || val.includes("\n")) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };
  const rows = entries.map((e) => {
    const isNote = e.entryType === ENTRY_TYPE.SECURE_NOTE;
    const isCard = e.entryType === ENTRY_TYPE.CREDIT_CARD;
    const isIdentity = e.entryType === ENTRY_TYPE.IDENTITY;
    const type = isIdentity ? "identity" : isCard ? "card" : isNote ? "securenote" : "login";
    const isLogin = !isNote && !isCard && !isIdentity;
    return [
      "", // folder
      "", // favorite
      type,
      escapeCsv(e.title),
      escapeCsv(isNote ? e.content : e.notes),
      "", // fields
      "", // reprompt
      isLogin ? escapeCsv(e.url) : "",
      isLogin ? escapeCsv(e.username) : "",
      isLogin ? escapeCsv(e.password) : "",
      isLogin ? escapeCsv(e.totp) : "",
    ].join(",");
  });
  return [header, ...rows].join("\n");
}

function formatJson(entries: OrgExportEntry[]): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      entries: entries.map((e) => {
        if (e.entryType === ENTRY_TYPE.IDENTITY) {
          return {
            type: "identity",
            name: e.title,
            identity: {
              fullName: e.fullName,
              address: e.address,
              phone: e.phone,
              email: e.email,
              dateOfBirth: e.dateOfBirth,
              nationality: e.nationality,
              idNumber: e.idNumber,
              issueDate: e.issueDate,
              expiryDate: e.expiryDate,
            },
            notes: e.notes,
          };
        }
        if (e.entryType === ENTRY_TYPE.CREDIT_CARD) {
          return {
            type: "card",
            name: e.title,
            card: {
              cardholderName: e.cardholderName,
              brand: e.brand,
              number: e.cardNumber,
              expMonth: e.expiryMonth,
              expYear: e.expiryYear,
              code: e.cvv,
            },
            notes: e.notes,
          };
        }
        if (e.entryType === ENTRY_TYPE.SECURE_NOTE) {
          return {
            type: "securenote",
            name: e.title,
            notes: e.content,
          };
        }
        return {
          type: "login",
          name: e.title,
          login: {
            username: e.username,
            password: e.password,
            uris: e.url ? [{ uri: e.url }] : [],
            totp: e.totp,
          },
          notes: e.notes,
        };
      }),
    },
    null,
    2
  );
}

function formatDate(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
