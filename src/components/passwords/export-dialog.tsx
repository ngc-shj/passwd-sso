"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
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
import { Download, Loader2, AlertTriangle } from "lucide-react";

type ExportFormat = "csv" | "json";

interface DecryptedExport {
  entryType: "LOGIN" | "SECURE_NOTE" | "CREDIT_CARD";
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
}

interface ExportDialogProps {
  trigger: React.ReactNode;
}

export function ExportDialog({ trigger }: ExportDialogProps) {
  const t = useTranslations("Export");
  const { encryptionKey } = useVault();
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleExport = async (format: ExportFormat) => {
    if (!encryptionKey) return;
    setExporting(true);

    try {
      const res = await fetch("/api/passwords?include=blob");
      if (!res.ok) throw new Error("Failed to fetch");
      const rawEntries = await res.json();

      const entries: DecryptedExport[] = [];
      for (const raw of rawEntries) {
        if (!raw.encryptedBlob) continue;
        try {
          const plaintext = await decryptData(
            raw.encryptedBlob as EncryptedData,
            encryptionKey
          );
          const parsed = JSON.parse(plaintext);
          entries.push({
            entryType: raw.entryType ?? "LOGIN",
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
          });
        } catch {
          // Skip entries that fail to decrypt
        }
      }

      let blob: Blob;
      let filename: string;

      if (format === "csv") {
        // Bitwarden-compatible CSV format
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
          const isNote = e.entryType === "SECURE_NOTE";
          const isCard = e.entryType === "CREDIT_CARD";
          const type = isCard ? "card" : isNote ? "securenote" : "login";
          return [
            "", // folder
            "", // favorite
            type,
            escapeCsv(e.title),
            escapeCsv(isNote ? e.content : e.notes), // notes column
            "", // fields
            "", // reprompt
            isNote || isCard ? "" : escapeCsv(e.url),
            isNote || isCard ? "" : escapeCsv(e.username),
            isNote || isCard ? "" : escapeCsv(e.password),
            isNote || isCard ? "" : escapeCsv(e.totp),
          ].join(",");
        });
        const csvContent = [header, ...rows].join("\n");
        blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
        filename = `passwd-sso-export-${formatDate()}.csv`;
      } else {
        const jsonContent = JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            entries: entries.map((e) => {
              if (e.entryType === "CREDIT_CARD") {
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
              if (e.entryType === "SECURE_NOTE") {
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
        blob = new Blob([jsonContent], { type: "application/json" });
        filename = `passwd-sso-export-${formatDate()}.json`;
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
      setOpen(false);
    } catch {
      // Export failed silently
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
          <AlertTriangle className="h-5 w-5 text-yellow-600 shrink-0 mt-0.5" />
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            {t("warning")}
          </p>
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

function formatDate(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
