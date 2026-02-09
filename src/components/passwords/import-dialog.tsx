"use client";

import { useState, useRef } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { encryptData } from "@/lib/crypto-client";
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
import { Upload, Loader2, FileUp, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";

// ─── CSV Parsing ────────────────────────────────────────────

interface ParsedEntry {
  entryType: "LOGIN" | "SECURE_NOTE" | "CREDIT_CARD";
  title: string;
  username: string;
  password: string;
  content: string;
  url: string;
  notes: string;
  cardholderName: string;
  cardNumber: string;
  brand: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
}

type CsvFormat = "bitwarden" | "onepassword" | "chrome" | "unknown";

function detectFormat(headers: string[]): CsvFormat {
  const lower = headers.map((h) => h.toLowerCase().trim());
  if (lower.includes("login_password") && lower.includes("login_username")) {
    return "bitwarden";
  }
  if (lower.includes("title") && lower.includes("password") && lower.includes("username")) {
    return "onepassword";
  }
  if (lower.includes("username") && lower.includes("password") && lower.includes("url") && !lower.includes("login_uri")) {
    // Chrome format: name,url,username,password  or  name,url,username,password,note
    return "chrome";
  }
  return "unknown";
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        fields.push(current);
        current = "";
      } else {
        current += char;
      }
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv(text: string): { entries: ParsedEntry[]; format: CsvFormat } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { entries: [], format: "unknown" };

  const headers = parseCsvLine(lines[0]);
  const format = detectFormat(headers);

  const entries: ParsedEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 2) continue;

    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h.toLowerCase().trim()] = fields[idx] ?? "";
    });

    let entry: ParsedEntry;

    const rowType = (row["type"] ?? "").toLowerCase();
    const isNote = rowType === "securenote" || rowType === "note";
    const isCard = rowType === "card";

    const cardDefaults = {
      cardholderName: "", cardNumber: "", brand: "",
      expiryMonth: "", expiryYear: "", cvv: "",
    };

    switch (format) {
      case "bitwarden":
        entry = {
          entryType: isCard ? "CREDIT_CARD" : isNote ? "SECURE_NOTE" : "LOGIN",
          title: row["name"] ?? "",
          username: row["login_username"] ?? "",
          password: row["login_password"] ?? "",
          content: isNote ? (row["notes"] ?? "") : "",
          url: row["login_uri"] ?? "",
          notes: isNote ? "" : (row["notes"] ?? ""),
          ...cardDefaults,
        };
        break;
      case "chrome":
        entry = {
          entryType: "LOGIN",
          title: row["name"] ?? "",
          username: row["username"] ?? "",
          password: row["password"] ?? "",
          content: "",
          url: row["url"] ?? "",
          notes: row["note"] ?? "",
          ...cardDefaults,
        };
        break;
      case "onepassword":
        entry = {
          entryType: isCard ? "CREDIT_CARD" : isNote ? "SECURE_NOTE" : "LOGIN",
          title: row["title"] ?? "",
          username: row["username"] ?? "",
          password: row["password"] ?? "",
          content: isNote ? (row["notes"] ?? "") : "",
          url: row["url"] ?? row["urls"] ?? "",
          notes: isNote ? "" : (row["notes"] ?? ""),
          ...cardDefaults,
        };
        break;
      default:
        entry = {
          entryType: isCard ? "CREDIT_CARD" : isNote ? "SECURE_NOTE" : "LOGIN",
          title: row["name"] ?? row["title"] ?? fields[0] ?? "",
          username: row["username"] ?? row["login_username"] ?? fields[1] ?? "",
          password: row["password"] ?? row["login_password"] ?? fields[2] ?? "",
          content: isNote ? (row["notes"] ?? "") : "",
          url: row["url"] ?? row["login_uri"] ?? "",
          notes: isNote ? "" : (row["notes"] ?? ""),
          ...cardDefaults,
        };
    }

    // Login entries need title+password, notes/cards need title only
    const valid = entry.entryType === "LOGIN"
      ? !!entry.title && !!entry.password
      : !!entry.title;
    if (valid) {
      entries.push(entry);
    }
  }

  return { entries, format };
}

// ─── JSON Parsing ───────────────────────────────────────────

function parseJson(text: string): { entries: ParsedEntry[]; format: CsvFormat } {
  try {
    const data = JSON.parse(text);
    const items = Array.isArray(data) ? data : (data.entries ?? data.items ?? []);
    if (!Array.isArray(items)) return { entries: [], format: "unknown" };

    const entries: ParsedEntry[] = [];

    for (const item of items) {
      const type = typeof item.type === "number"
        ? item.type
        : (item.type ?? "").toLowerCase();

      const cardDefaults = {
        cardholderName: "", cardNumber: "", brand: "",
        expiryMonth: "", expiryYear: "", cvv: "",
      };

      // Bitwarden JSON: type=3 or type="card"
      if (type === 3 || type === "card") {
        const card = item.card ?? {};
        const entry: ParsedEntry = {
          entryType: "CREDIT_CARD",
          title: item.name ?? "",
          username: "", password: "", content: "",
          url: "",
          notes: item.notes ?? "",
          cardholderName: card.cardholderName ?? "",
          cardNumber: card.number ?? "",
          brand: card.brand ?? "",
          expiryMonth: card.expMonth ?? "",
          expiryYear: card.expYear ?? "",
          cvv: card.code ?? "",
        };
        if (entry.title) entries.push(entry);
        continue;
      }

      // Bitwarden JSON: type=2 or type="securenote"
      if (type === 2 || type === "securenote") {
        const entry: ParsedEntry = {
          entryType: "SECURE_NOTE",
          title: item.name ?? "",
          username: "", password: "",
          content: item.notes ?? "",
          url: "",
          notes: "",
          ...cardDefaults,
        };
        if (entry.title) entries.push(entry);
        continue;
      }

      // Login (type=1 or type="login" or default)
      const login = item.login ?? {};
      const uris = login.uris ?? [];
      const entry: ParsedEntry = {
        entryType: "LOGIN",
        title: item.name ?? "",
        username: login.username ?? "",
        password: login.password ?? "",
        content: "",
        url: uris[0]?.uri ?? "",
        notes: item.notes ?? "",
        ...cardDefaults,
      };
      if (entry.title && entry.password) entries.push(entry);
    }

    return { entries, format: "bitwarden" };
  } catch {
    return { entries: [], format: "unknown" };
  }
}

// ─── Format label ───────────────────────────────────────────

const formatLabels: Record<CsvFormat, string> = {
  bitwarden: "Bitwarden",
  onepassword: "1Password",
  chrome: "Chrome",
  unknown: "CSV",
};

// ─── Component ──────────────────────────────────────────────

interface ImportDialogProps {
  trigger: React.ReactNode;
  onComplete: () => void;
}

export function ImportDialog({ trigger, onComplete }: ImportDialogProps) {
  const t = useTranslations("Import");
  const { encryptionKey } = useVault();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ParsedEntry[]>([]);
  const [format, setFormat] = useState<CsvFormat>("unknown");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [done, setDone] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const reset = () => {
    setEntries([]);
    setFormat("unknown");
    setImporting(false);
    setProgress({ current: 0, total: 0 });
    setDone(false);
    setDragOver(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const loadFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;

      if (file.name.endsWith(".json")) {
        const result = parseJson(text);
        setEntries(result.entries);
        setFormat(result.format);
      } else {
        const result = parseCsv(text);
        setEntries(result.entries);
        setFormat(result.format);
      }
    };
    reader.readAsText(file);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith(".csv") || file.name.endsWith(".json"))) loadFile(file);
  };

  const handleImport = async () => {
    if (!encryptionKey || entries.length === 0) return;
    setImporting(true);
    setProgress({ current: 0, total: entries.length });

    let successCount = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      setProgress({ current: i + 1, total: entries.length });

      try {
        const isNote = entry.entryType === "SECURE_NOTE";
        const isCard = entry.entryType === "CREDIT_CARD";
        let fullBlob: string;
        let overviewBlob: string;

        if (isCard) {
          const lastFour = entry.cardNumber
            ? entry.cardNumber.replace(/\s/g, "").slice(-4)
            : null;
          fullBlob = JSON.stringify({
            title: entry.title,
            cardholderName: entry.cardholderName || null,
            cardNumber: entry.cardNumber || null,
            brand: entry.brand || null,
            expiryMonth: entry.expiryMonth || null,
            expiryYear: entry.expiryYear || null,
            cvv: entry.cvv || null,
            notes: entry.notes || null,
            tags: [],
          });
          overviewBlob = JSON.stringify({
            title: entry.title,
            cardholderName: entry.cardholderName || null,
            brand: entry.brand || null,
            lastFour,
            tags: [],
          });
        } else if (isNote) {
          fullBlob = JSON.stringify({
            title: entry.title,
            content: entry.content || "",
            tags: [],
          });
          overviewBlob = JSON.stringify({
            title: entry.title,
            snippet: (entry.content || "").slice(0, 100),
            tags: [],
          });
        } else {
          let urlHost: string | null = null;
          if (entry.url) {
            try {
              urlHost = new URL(entry.url).hostname;
            } catch {
              /* invalid url */
            }
          }
          fullBlob = JSON.stringify({
            title: entry.title,
            username: entry.username || null,
            password: entry.password,
            url: entry.url || null,
            notes: entry.notes || null,
            tags: [],
            generatorSettings: null,
          });
          overviewBlob = JSON.stringify({
            title: entry.title,
            username: entry.username || null,
            urlHost,
            tags: [],
          });
        }

        const encryptedBlob = await encryptData(fullBlob, encryptionKey);
        const encryptedOverview = await encryptData(overviewBlob, encryptionKey);

        const res = await fetch("/api/passwords", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            encryptedBlob,
            encryptedOverview,
            entryType: entry.entryType,
            keyVersion: 1,
          }),
        });

        if (res.ok) successCount++;
      } catch {
        // Skip failed entries
      }
    }

    setDone(true);
    setImporting(false);

    if (successCount > 0) {
      toast.success(t("importedCount", { count: successCount }));
      onComplete();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <CheckCircle2 className="h-10 w-10 text-green-500" />
            <p className="text-sm text-muted-foreground">
              {t("importedCount", { count: progress.total })}
            </p>
            <Button onClick={() => setOpen(false)}>{t("close")}</Button>
          </div>
        ) : entries.length === 0 ? (
          // File selection step
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t("supportedFormats")}</p>
            <label
              className={`flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 cursor-pointer transition-colors ${
                dragOver
                  ? "border-primary bg-primary/10"
                  : "hover:bg-muted/50"
              }`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              <FileUp className={`h-8 w-8 ${dragOver ? "text-primary" : "text-muted-foreground"}`} />
              <span className="text-sm text-muted-foreground">{t("selectFile")}</span>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.json"
                className="hidden"
                onChange={handleFileChange}
              />
            </label>
          </div>
        ) : (
          // Preview step
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t("detectedFormat")}:</span>
              <span className="font-medium">{formatLabels[format]}</span>
            </div>

            {format === "unknown" && (
              <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
                <AlertCircle className="h-4 w-4 text-yellow-600 shrink-0 mt-0.5" />
                <p className="text-xs text-yellow-800 dark:text-yellow-200">
                  {t("unknownFormat")}
                </p>
              </div>
            )}

            <div className="max-h-60 overflow-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">{t("colTitle")}</th>
                    <th className="px-2 py-1 text-left font-medium">{t("colType")}</th>
                    <th className="px-2 py-1 text-left font-medium">{t("colUsername")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {entries.map((entry, i) => (
                    <tr key={i}>
                      <td className="px-2 py-1 truncate max-w-[120px]">{entry.title}</td>
                      <td className="px-2 py-1 text-muted-foreground">
                        {entry.entryType === "CREDIT_CARD"
                          ? t("typeCard")
                          : entry.entryType === "SECURE_NOTE"
                            ? t("typeNote")
                            : t("typeLogin")}
                      </td>
                      <td className="px-2 py-1 truncate max-w-[120px]">
                        {entry.entryType === "LOGIN" ? entry.username : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-sm text-muted-foreground">
              {t("entryCount", { count: entries.length })}
            </p>

            {importing && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("importing", {
                  current: progress.current,
                  total: progress.total,
                })}
              </div>
            )}
          </div>
        )}

        {!done && entries.length > 0 && (
          <DialogFooter>
            <Button variant="outline" onClick={reset} disabled={importing}>
              {t("back")}
            </Button>
            <Button onClick={handleImport} disabled={importing}>
              {importing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Upload className="h-4 w-4 mr-2" />
              )}
              {t("importButton", { count: entries.length })}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
