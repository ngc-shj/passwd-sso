"use client";

import { useState, useRef } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { encryptData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD, AAD_VERSION } from "@/lib/crypto-aad";
import {
  isEncryptedExport,
  decryptExport,
  type EncryptedExportFile,
} from "@/lib/export-crypto";
import {
  Dialog,
  DialogClose,
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
import { Upload, Loader2, FileUp, CheckCircle2, AlertCircle, Lock } from "lucide-react";
import { toast } from "sonner";
import { API_PATH, ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";

// ─── CSV Parsing ────────────────────────────────────────────

interface ParsedEntry {
  entryType: EntryTypeValue;
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
  fullName: string;
  address: string;
  phone: string;
  email: string;
  dateOfBirth: string;
  nationality: string;
  idNumber: string;
  issueDate: string;
  expiryDate: string;
  relyingPartyId: string;
  relyingPartyName: string;
  credentialId: string;
  creationDate: string;
  deviceInfo: string;
  tags: Array<{ name: string; color: string | null }>;
  customFields: Array<{ label: string; value: string; type: string }>;
  totp: {
    secret: string;
    issuer?: string;
    label?: string;
    period?: number;
    digits?: number;
    algorithm?: string;
  } | null;
  generatorSettings: Record<string, unknown> | null;
  passwordHistory: Array<{ password: string; changedAt: string }>;
}

type CsvFormat = "bitwarden" | "onepassword" | "chrome" | "passwd-sso" | "unknown";

function extraDefaults(): Pick<
  ParsedEntry,
  "tags" | "customFields" | "totp" | "generatorSettings" | "passwordHistory"
> {
  return {
    tags: [],
    customFields: [],
    totp: null,
    generatorSettings: null,
    passwordHistory: [],
  };
}

function parsePasswdSsoPayload(raw: string | undefined): Partial<ParsedEntry> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return {
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      customFields: Array.isArray(parsed.customFields) ? parsed.customFields : [],
      totp:
        parsed.totp && typeof parsed.totp === "object" && typeof parsed.totp.secret === "string"
          ? parsed.totp
          : null,
      generatorSettings:
        parsed.generatorSettings && typeof parsed.generatorSettings === "object"
          ? parsed.generatorSettings
          : null,
      passwordHistory: Array.isArray(parsed.passwordHistory) ? parsed.passwordHistory : [],
      cardholderName: typeof parsed.cardholderName === "string" ? parsed.cardholderName : "",
      cardNumber: typeof parsed.cardNumber === "string" ? parsed.cardNumber : "",
      brand: typeof parsed.brand === "string" ? parsed.brand : "",
      expiryMonth: typeof parsed.expiryMonth === "string" ? parsed.expiryMonth : "",
      expiryYear: typeof parsed.expiryYear === "string" ? parsed.expiryYear : "",
      cvv: typeof parsed.cvv === "string" ? parsed.cvv : "",
      fullName: typeof parsed.fullName === "string" ? parsed.fullName : "",
      address: typeof parsed.address === "string" ? parsed.address : "",
      phone: typeof parsed.phone === "string" ? parsed.phone : "",
      email: typeof parsed.email === "string" ? parsed.email : "",
      dateOfBirth: typeof parsed.dateOfBirth === "string" ? parsed.dateOfBirth : "",
      nationality: typeof parsed.nationality === "string" ? parsed.nationality : "",
      idNumber: typeof parsed.idNumber === "string" ? parsed.idNumber : "",
      issueDate: typeof parsed.issueDate === "string" ? parsed.issueDate : "",
      expiryDate: typeof parsed.expiryDate === "string" ? parsed.expiryDate : "",
      relyingPartyId: typeof parsed.relyingPartyId === "string" ? parsed.relyingPartyId : "",
      relyingPartyName: typeof parsed.relyingPartyName === "string" ? parsed.relyingPartyName : "",
      credentialId: typeof parsed.credentialId === "string" ? parsed.credentialId : "",
      creationDate: typeof parsed.creationDate === "string" ? parsed.creationDate : "",
      deviceInfo: typeof parsed.deviceInfo === "string" ? parsed.deviceInfo : "",
    };
  } catch {
    return {};
  }
}

function detectFormat(headers: string[]): CsvFormat {
  const lower = headers.map((h) => h.toLowerCase().trim());
  if (lower.includes("passwd_sso")) {
    return "passwd-sso";
  }
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
    const isIdentity = rowType === "identity";
    const passwdSso = parsePasswdSsoPayload(row["passwd_sso"]);

    const cardDefaults = {
      cardholderName: "", cardNumber: "", brand: "",
      expiryMonth: "", expiryYear: "", cvv: "",
    };
    const identityDefaults = {
      fullName: "", address: "", phone: "", email: "",
      dateOfBirth: "", nationality: "", idNumber: "",
      issueDate: "", expiryDate: "",
    };
    const passkeyDefaults = {
      relyingPartyId: "", relyingPartyName: "",
      credentialId: "", creationDate: "", deviceInfo: "",
    };

    switch (format) {
      case "bitwarden":
        entry = {
          entryType: isIdentity ? ENTRY_TYPE.IDENTITY : isCard ? ENTRY_TYPE.CREDIT_CARD : isNote ? ENTRY_TYPE.SECURE_NOTE : ENTRY_TYPE.LOGIN,
          title: row["name"] ?? "",
          username: row["login_username"] ?? "",
          password: row["login_password"] ?? "",
          content: isNote ? (row["notes"] ?? "") : "",
          url: row["login_uri"] ?? "",
          notes: isNote ? "" : (row["notes"] ?? ""),
          ...cardDefaults,
          ...identityDefaults,
          ...passkeyDefaults,
          ...extraDefaults(),
        };
        break;
      case "chrome":
        entry = {
          entryType: ENTRY_TYPE.LOGIN,
          title: row["name"] ?? "",
          username: row["username"] ?? "",
          password: row["password"] ?? "",
          content: "",
          url: row["url"] ?? "",
          notes: row["note"] ?? "",
          ...cardDefaults,
          ...identityDefaults,
          ...passkeyDefaults,
          ...extraDefaults(),
        };
        break;
      case "onepassword":
        entry = {
          entryType: isIdentity ? ENTRY_TYPE.IDENTITY : isCard ? ENTRY_TYPE.CREDIT_CARD : isNote ? ENTRY_TYPE.SECURE_NOTE : ENTRY_TYPE.LOGIN,
          title: row["title"] ?? "",
          username: row["username"] ?? "",
          password: row["password"] ?? "",
          content: isNote ? (row["notes"] ?? "") : "",
          url: row["url"] ?? row["urls"] ?? "",
          notes: isNote ? "" : (row["notes"] ?? ""),
          ...cardDefaults,
          ...identityDefaults,
          ...passkeyDefaults,
          ...extraDefaults(),
        };
        break;
      default:
        entry = {
          entryType: isIdentity ? ENTRY_TYPE.IDENTITY : isCard ? ENTRY_TYPE.CREDIT_CARD : isNote ? ENTRY_TYPE.SECURE_NOTE : ENTRY_TYPE.LOGIN,
          title: row["name"] ?? row["title"] ?? fields[0] ?? "",
          username: row["username"] ?? row["login_username"] ?? fields[1] ?? "",
          password: row["password"] ?? row["login_password"] ?? fields[2] ?? "",
          content: isNote ? (row["notes"] ?? "") : "",
          url: row["url"] ?? row["login_uri"] ?? "",
          notes: isNote ? "" : (row["notes"] ?? ""),
          ...cardDefaults,
          ...identityDefaults,
          ...passkeyDefaults,
          ...extraDefaults(),
        };
    }

    if (!entry.totp && typeof row["login_totp"] === "string" && row["login_totp"]) {
      entry.totp = { secret: row["login_totp"] };
    }
    entry = { ...entry, ...passwdSso };

    // Login entries need title+password, notes/cards/identities/passkeys need title only
    const valid = entry.entryType === ENTRY_TYPE.LOGIN
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
    const exportFormat: CsvFormat =
      data && typeof data === "object" && data.format === "passwd-sso"
        ? "passwd-sso"
        : "bitwarden";

    const entries: ParsedEntry[] = [];

    for (const item of items) {
      const type = typeof item.type === "number"
        ? item.type
        : (item.type ?? "").toLowerCase();
      const passwdSso =
        item.passwdSso && typeof item.passwdSso === "object"
          ? parsePasswdSsoPayload(JSON.stringify(item.passwdSso))
          : {};

      const cardDefaults = {
        cardholderName: "", cardNumber: "", brand: "",
        expiryMonth: "", expiryYear: "", cvv: "",
      };
      const identityDefaults = {
        fullName: "", address: "", phone: "", email: "",
        dateOfBirth: "", nationality: "", idNumber: "",
        issueDate: "", expiryDate: "",
      };
      const passkeyDefaults = {
        relyingPartyId: "", relyingPartyName: "",
        credentialId: "", creationDate: "", deviceInfo: "",
      };

      // JSON: type="passkey"
      if (type === "passkey") {
        const passkey = item.passkey ?? {};
        const entry: ParsedEntry = {
          entryType: ENTRY_TYPE.PASSKEY,
          title: item.name ?? "",
          username: passkey.username ?? "", password: "", content: "",
          url: "",
          notes: item.notes ?? "",
          ...cardDefaults,
          ...identityDefaults,
          relyingPartyId: passkey.relyingPartyId ?? "",
          relyingPartyName: passkey.relyingPartyName ?? "",
          credentialId: passkey.credentialId ?? "",
          creationDate: passkey.creationDate ?? "",
          deviceInfo: passkey.deviceInfo ?? "",
          ...extraDefaults(),
          ...passwdSso,
        };
        if (entry.title) entries.push(entry);
        continue;
      }

      // Bitwarden JSON: type=4 or type="identity"
      if (type === 4 || type === "identity") {
        const identity = item.identity ?? {};
        const entry: ParsedEntry = {
          entryType: ENTRY_TYPE.IDENTITY,
          title: item.name ?? "",
          username: "", password: "", content: "",
          url: "",
          notes: item.notes ?? "",
          ...cardDefaults,
          ...passkeyDefaults,
          fullName: identity.fullName ?? identity.firstName
            ? `${identity.firstName ?? ""} ${identity.lastName ?? ""}`.trim()
            : "",
          address: identity.address ?? identity.address1 ?? "",
          phone: identity.phone ?? "",
          email: identity.email ?? "",
          dateOfBirth: identity.dateOfBirth ?? "",
          nationality: identity.nationality ?? "",
          idNumber: identity.idNumber ?? identity.ssn ?? identity.passportNumber ?? "",
          issueDate: identity.issueDate ?? "",
          expiryDate: identity.expiryDate ?? "",
          ...extraDefaults(),
          ...passwdSso,
        };
        if (entry.title) entries.push(entry);
        continue;
      }

      // Bitwarden JSON: type=3 or type="card"
      if (type === 3 || type === "card") {
        const card = item.card ?? {};
        const entry: ParsedEntry = {
          entryType: ENTRY_TYPE.CREDIT_CARD,
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
          ...identityDefaults,
          ...passkeyDefaults,
          ...extraDefaults(),
          ...passwdSso,
        };
        if (entry.title) entries.push(entry);
        continue;
      }

      // Bitwarden JSON: type=2 or type="securenote"
      if (type === 2 || type === "securenote") {
        const entry: ParsedEntry = {
          entryType: ENTRY_TYPE.SECURE_NOTE,
          title: item.name ?? "",
          username: "", password: "",
          content: item.notes ?? "",
          url: "",
          notes: "",
          ...cardDefaults,
          ...identityDefaults,
          ...passkeyDefaults,
          ...extraDefaults(),
          ...passwdSso,
        };
        if (entry.title) entries.push(entry);
        continue;
      }

      // Login (type=1 or type="login" or default)
      const login = item.login ?? {};
      const uris = login.uris ?? [];
      const entry: ParsedEntry = {
        entryType: ENTRY_TYPE.LOGIN,
        title: item.name ?? "",
        username: login.username ?? "",
        password: login.password ?? "",
        content: "",
        url: uris[0]?.uri ?? "",
        notes: item.notes ?? "",
        ...cardDefaults,
        ...identityDefaults,
        ...passkeyDefaults,
        ...extraDefaults(),
        totp: typeof login.totp === "string" && login.totp ? { secret: login.totp } : null,
        ...passwdSso,
      };
      if (entry.title && entry.password) entries.push(entry);
    }

    return { entries, format: exportFormat };
  } catch {
    return { entries: [], format: "unknown" };
  }
}

// ─── Format label ───────────────────────────────────────────

const formatLabels: Record<CsvFormat, string> = {
  bitwarden: "Bitwarden",
  onepassword: "1Password",
  chrome: "Chrome",
  "passwd-sso": "passwd-sso",
  unknown: "CSV",
};

// ─── Component ──────────────────────────────────────────────

interface ImportDialogProps {
  trigger: React.ReactNode;
  onComplete: () => void;
}

export function ImportDialog({ trigger, onComplete }: ImportDialogProps) {
  const t = useTranslations("Import");
  const { encryptionKey, userId } = useVault();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ParsedEntry[]>([]);
  const [format, setFormat] = useState<CsvFormat>("unknown");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [done, setDone] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [encryptedFile, setEncryptedFile] = useState<EncryptedExportFile | null>(null);
  const [decryptPassword, setDecryptPassword] = useState("");
  const [decrypting, setDecrypting] = useState(false);
  const [decryptError, setDecryptError] = useState("");
  const [sourceFilename, setSourceFilename] = useState("");

  const reset = () => {
    setEntries([]);
    setFormat("unknown");
    setImporting(false);
    setProgress({ current: 0, total: 0 });
    setDone(false);
    setDragOver(false);
    setEncryptedFile(null);
    setDecryptPassword("");
    setDecrypting(false);
    setDecryptError("");
    setSourceFilename("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const parseContent = (text: string, isJson: boolean) => {
    if (isJson) {
      const result = parseJson(text);
      setEntries(result.entries);
      setFormat(result.format);
    } else {
      const result = parseCsv(text);
      setEntries(result.entries);
      setFormat(result.format);
    }
  };

  const loadFile = (file: File) => {
    setSourceFilename(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;

      if (file.name.endsWith(".json")) {
        // Check if it's an encrypted export
        try {
          const parsed = JSON.parse(text);
          if (isEncryptedExport(parsed)) {
            setEncryptedFile(parsed);
            return;
          }
        } catch {
          // Not valid JSON, fall through to regular parsing
        }
        parseContent(text, true);
      } else {
        parseContent(text, false);
      }
    };
    reader.readAsText(file);
  };

  const handleDecrypt = async () => {
    if (!encryptedFile) return;
    setDecrypting(true);
    setDecryptError("");

    try {
      const { plaintext, format: originalFormat } = await decryptExport(
        encryptedFile,
        decryptPassword
      );
      parseContent(plaintext, originalFormat === "json");
      setEncryptedFile(null);
      setDecryptPassword("");
    } catch {
      setDecryptError(t("decryptionFailed"));
    } finally {
      setDecrypting(false);
    }
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
        const isNote = entry.entryType === ENTRY_TYPE.SECURE_NOTE;
        const isCard = entry.entryType === ENTRY_TYPE.CREDIT_CARD;
        const isIdentity = entry.entryType === ENTRY_TYPE.IDENTITY;
        const isPasskey = entry.entryType === ENTRY_TYPE.PASSKEY;
        let fullBlob: string;
        let overviewBlob: string;

        if (isPasskey) {
          fullBlob = JSON.stringify({
            title: entry.title,
            relyingPartyId: entry.relyingPartyId || null,
            relyingPartyName: entry.relyingPartyName || null,
            username: entry.username || null,
            credentialId: entry.credentialId || null,
            creationDate: entry.creationDate || null,
            deviceInfo: entry.deviceInfo || null,
            notes: entry.notes || null,
            tags: entry.tags,
          });
          overviewBlob = JSON.stringify({
            title: entry.title,
            relyingPartyId: entry.relyingPartyId || null,
            username: entry.username || null,
            tags: entry.tags,
          });
        } else if (isIdentity) {
          const idNumberLast4 = entry.idNumber ? entry.idNumber.slice(-4) : null;
          fullBlob = JSON.stringify({
            title: entry.title,
            fullName: entry.fullName || null,
            address: entry.address || null,
            phone: entry.phone || null,
            email: entry.email || null,
            dateOfBirth: entry.dateOfBirth || null,
            nationality: entry.nationality || null,
            idNumber: entry.idNumber || null,
            issueDate: entry.issueDate || null,
            expiryDate: entry.expiryDate || null,
            notes: entry.notes || null,
            tags: entry.tags,
          });
          overviewBlob = JSON.stringify({
            title: entry.title,
            fullName: entry.fullName || null,
            idNumberLast4,
            tags: entry.tags,
          });
        } else if (isCard) {
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
            tags: entry.tags,
          });
          overviewBlob = JSON.stringify({
            title: entry.title,
            cardholderName: entry.cardholderName || null,
            brand: entry.brand || null,
            lastFour,
            tags: entry.tags,
          });
        } else if (isNote) {
          fullBlob = JSON.stringify({
            title: entry.title,
            content: entry.content || "",
            tags: entry.tags,
          });
          overviewBlob = JSON.stringify({
            title: entry.title,
            snippet: (entry.content || "").slice(0, 100),
            tags: entry.tags,
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
            tags: entry.tags,
            generatorSettings: entry.generatorSettings,
            ...(entry.passwordHistory.length > 0 && { passwordHistory: entry.passwordHistory }),
            ...(entry.customFields.length > 0 && { customFields: entry.customFields }),
            ...(entry.totp && { totp: entry.totp }),
          });
          overviewBlob = JSON.stringify({
            title: entry.title,
            username: entry.username || null,
            urlHost,
            tags: entry.tags,
          });
        }

        const entryId = crypto.randomUUID();
        const aad = userId ? buildPersonalEntryAAD(userId, entryId) : undefined;

        const encryptedBlob = await encryptData(fullBlob, encryptionKey, aad);
        const encryptedOverview = await encryptData(overviewBlob, encryptionKey, aad);

        const res = await fetch(API_PATH.PASSWORDS, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-passwd-sso-source": "import",
            ...(sourceFilename
              ? { "x-passwd-sso-filename": sourceFilename }
              : {}),
          },
          body: JSON.stringify({
            id: entryId,
            encryptedBlob,
            encryptedOverview,
            entryType: entry.entryType,
            keyVersion: 1,
            aadVersion: aad ? AAD_VERSION : 0,
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp className="h-4 w-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <CheckCircle2 className="h-10 w-10 text-green-500" />
            <p className="text-sm text-muted-foreground">
              {t("importedCount", { count: progress.total })}
            </p>
            <DialogClose asChild>
              <Button type="button">{t("close")}</Button>
            </DialogClose>
          </div>
        ) : encryptedFile ? (
          // Decryption step
          <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
            <div className="flex items-start gap-3 rounded-lg border border-blue-500/30 bg-blue-500/10 p-3">
              <Lock className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
              <p className="text-sm text-blue-800 dark:text-blue-200">
                {t("encryptedFileDetected")}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="decrypt-password" className="text-sm">
                {t("decryptPassword")}
              </Label>
              <Input
                id="decrypt-password"
                type="password"
                value={decryptPassword}
                onChange={(e) => {
                  setDecryptPassword(e.target.value);
                  setDecryptError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && decryptPassword) handleDecrypt();
                }}
                autoComplete="off"
                autoFocus
              />
            </div>
            {decryptError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
                <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                <p className="text-xs text-destructive">
                  {decryptError}
                </p>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={reset} disabled={decrypting}>
                {t("back")}
              </Button>
              <Button
                onClick={handleDecrypt}
                disabled={decrypting || !decryptPassword}
              >
                {decrypting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Lock className="h-4 w-4 mr-2" />
                )}
                {decrypting ? t("decrypting") : t("decryptButton")}
              </Button>
            </DialogFooter>
          </div>
        ) : entries.length === 0 ? (
          // File selection step
          <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
            <p className="text-sm text-muted-foreground">{t("supportedFormats")}</p>
            <label
              className={`flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 cursor-pointer transition-colors ${
                dragOver
                  ? "border-primary bg-primary/10"
                  : "hover:bg-muted/60"
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
          <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t("detectedFormat")}:</span>
              <span className="font-medium">{formatLabels[format]}</span>
            </div>

            {format === "unknown" && (
              <div className="flex items-start gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3">
                <AlertCircle className="h-4 w-4 text-yellow-600 shrink-0 mt-0.5" />
                <p className="text-xs text-yellow-800 dark:text-yellow-200">
                  {t("unknownFormat")}
                </p>
              </div>
            )}

            <div className="max-h-60 overflow-auto rounded-lg border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur">
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
                        {entry.entryType === ENTRY_TYPE.PASSKEY
                          ? t("typePasskey")
                          : entry.entryType === ENTRY_TYPE.IDENTITY
                            ? t("typeIdentity")
                            : entry.entryType === ENTRY_TYPE.CREDIT_CARD
                              ? t("typeCard")
                              : entry.entryType === ENTRY_TYPE.SECURE_NOTE
                                ? t("typeNote")
                                : t("typeLogin")}
                      </td>
                      <td className="px-2 py-1 truncate max-w-[120px]">
                        {entry.entryType === ENTRY_TYPE.LOGIN ? entry.username : "—"}
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
          <DialogFooter className="border-t pt-4">
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

export const __testablesImport = {
  detectFormat,
  parseCsvLine,
  parseCsv,
  parseJson,
  parsePasswdSsoPayload,
};
