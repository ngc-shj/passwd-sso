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
  DialogFooter,
} from "@/components/ui/dialog";
import { PagePane } from "@/components/layout/page-pane";
import { PageTitleCard } from "@/components/layout/page-title-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Upload, Loader2, FileUp, CheckCircle2, AlertCircle, Lock } from "lucide-react";
import { toast } from "sonner";
import { API_PATH, ENTRY_TYPE } from "@/lib/constants";
import { apiPath } from "@/lib/constants/api-path";
import {
  formatLabels,
  importTestables,
  parseCsv,
  parseJson,
  resolveEntryTagIds,
  resolveTagNameToIdForImport,
  type ParsedEntry,
} from "@/components/passwords/import-dialog-utils";

// ─── Component ──────────────────────────────────────────────

interface ImportPanelContentProps {
  onComplete: () => void;
  orgId?: string;
}

function ImportPanelContent({ onComplete, orgId }: ImportPanelContentProps) {
  const t = useTranslations("Import");
  const { encryptionKey, userId } = useVault();
  const isOrgImport = Boolean(orgId);
  const tagsPath = orgId ? apiPath.orgTags(orgId) : API_PATH.TAGS;
  const passwordsPath = orgId ? apiPath.orgPasswords(orgId) : API_PATH.PASSWORDS;
  const fileRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<ParsedEntry[]>([]);
  const [format, setFormat] = useState<CsvFormat>("unknown");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [done, setDone] = useState(false);
  const [result, setResult] = useState({ success: 0, failed: 0 });
  const [dragOver, setDragOver] = useState(false);
  const [encryptedFile, setEncryptedFile] = useState<EncryptedExportFile | null>(null);
  const [decryptPassword, setDecryptPassword] = useState("");
  const [decrypting, setDecrypting] = useState(false);
  const [decryptError, setDecryptError] = useState("");
  const [sourceFilename, setSourceFilename] = useState("");
  const [encryptedInput, setEncryptedInput] = useState(false);

  const reset = () => {
    setEntries([]);
    setFormat("unknown");
    setImporting(false);
    setProgress({ current: 0, total: 0 });
    setDone(false);
    setResult({ success: 0, failed: 0 });
    setDragOver(false);
    setEncryptedFile(null);
    setDecryptPassword("");
    setDecrypting(false);
    setDecryptError("");
    setSourceFilename("");
    setEncryptedInput(false);
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
            setEncryptedInput(true);
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
    if (entries.length === 0) return;
    if (!isOrgImport && !encryptionKey) return;
    setImporting(true);
    setProgress({ current: 0, total: entries.length });

    let successCount = 0;
    const tagNameToId = await resolveTagNameToIdForImport(entries, tagsPath);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      setProgress({ current: i + 1, total: entries.length });

      try {
        const isNote = entry.entryType === ENTRY_TYPE.SECURE_NOTE;
        const isCard = entry.entryType === ENTRY_TYPE.CREDIT_CARD;
        const isIdentity = entry.entryType === ENTRY_TYPE.IDENTITY;
        const isPasskey = entry.entryType === ENTRY_TYPE.PASSKEY;
        const tagIds = resolveEntryTagIds(entry, tagNameToId);
        let res: Response;
        if (isOrgImport) {
          res = await fetch(passwordsPath, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-passwd-sso-source": "import",
              ...(sourceFilename
                ? { "x-passwd-sso-filename": sourceFilename }
                : {}),
            },
            body: JSON.stringify(
              isNote
                ? {
                    entryType: ENTRY_TYPE.SECURE_NOTE,
                    title: entry.title,
                    content: entry.content || "",
                    tagIds,
                  }
                : isPasskey
                  ? {
                      entryType: ENTRY_TYPE.PASSKEY,
                      title: entry.title,
                      relyingPartyId: entry.relyingPartyId || "",
                      relyingPartyName: entry.relyingPartyName || "",
                      username: entry.username || "",
                      credentialId: entry.credentialId || "",
                      creationDate: entry.creationDate || "",
                      deviceInfo: entry.deviceInfo || "",
                      notes: entry.notes || "",
                      tagIds,
                    }
                : isCard
                  ? {
                      entryType: ENTRY_TYPE.CREDIT_CARD,
                      title: entry.title,
                      cardholderName: entry.cardholderName || "",
                      cardNumber: entry.cardNumber || "",
                      brand: entry.brand || "",
                      expiryMonth: entry.expiryMonth || "",
                      expiryYear: entry.expiryYear || "",
                      cvv: entry.cvv || "",
                      notes: entry.notes || "",
                      tagIds,
                    }
                  : isIdentity
                    ? {
                        entryType: ENTRY_TYPE.IDENTITY,
                        title: entry.title,
                        fullName: entry.fullName || "",
                        address: entry.address || "",
                        phone: entry.phone || "",
                        email: entry.email || "",
                        dateOfBirth: entry.dateOfBirth || "",
                        nationality: entry.nationality || "",
                        idNumber: entry.idNumber || "",
                        issueDate: entry.issueDate || "",
                        expiryDate: entry.expiryDate || "",
                        notes: entry.notes || "",
                        tagIds,
                      }
                    : {
                        title: entry.title,
                        username: entry.username || "",
                        password: entry.password,
                        url: entry.url || "",
                        notes: entry.notes || "",
                        customFields: entry.customFields,
                        ...(entry.totp ? { totp: entry.totp } : {}),
                        tagIds,
                      }
            ),
          });
        } else {
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
              requireReprompt: entry.requireReprompt,
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
              requireReprompt: entry.requireReprompt,
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
              requireReprompt: entry.requireReprompt,
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
              requireReprompt: entry.requireReprompt,
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
              requireReprompt: entry.requireReprompt,
            });
          }

          const entryId = crypto.randomUUID();
          const aad = userId ? buildPersonalEntryAAD(userId, entryId) : undefined;
          const encryptedBlob = await encryptData(fullBlob, encryptionKey!, aad);
          const encryptedOverview = await encryptData(overviewBlob, encryptionKey!, aad);

          res = await fetch(passwordsPath, {
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
              tagIds,
              ...(entry.requireReprompt ? { requireReprompt: true } : {}),
            }),
          });
        }

        if (res.ok) successCount++;
      } catch {
        // Skip failed entries
      }
    }

    setDone(true);
    setImporting(false);

    const failedCount = Math.max(0, entries.length - successCount);
    setResult({ success: successCount, failed: failedCount });
    if (!isOrgImport) {
      fetch(API_PATH.AUDIT_LOGS_IMPORT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestedCount: entries.length,
          successCount,
          failedCount,
          filename: sourceFilename || undefined,
          format: sourceFilename.toLowerCase().endsWith(".json") ? "json" : "csv",
          encrypted: encryptedInput,
        }),
      }).catch(() => {});
    }

    if (successCount > 0) {
      toast.success(t("importedCount", { count: successCount }));
      onComplete();
    }
  };

  const content = (
    <>
        {done ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <CheckCircle2 className="h-10 w-10 text-green-500" />
            <p className="text-sm text-muted-foreground">
              {t("importedCount", { count: result.success })}
            </p>
            <Button type="button" onClick={reset}>
              {t("close")}
            </Button>
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
              className={`flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 transition-colors ${
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
    </>
  );

  return content;
}

interface ImportPagePanelProps {
  onComplete: () => void;
  orgId?: string;
}

export function ImportPagePanel({ onComplete, orgId }: ImportPagePanelProps) {
  const t = useTranslations("Import");
  return (
    <PagePane
      header={
        <PageTitleCard
          icon={<FileUp className="h-5 w-5" />}
          title={t("title")}
          description={t("description")}
        />
      }
    >
      <ImportPanelContent onComplete={onComplete} orgId={orgId} />
    </PagePane>
  );
}

interface OrgImportPagePanelProps {
  orgId: string;
  onComplete: () => void;
}

export function OrgImportPagePanel({ orgId, onComplete }: OrgImportPagePanelProps) {
  return <ImportPagePanel onComplete={onComplete} orgId={orgId} />;
}

export const __testablesImport = importTestables;
