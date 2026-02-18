"use client";

import type { RefObject } from "react";
import { API_PATH, ENTRY_TYPE } from "@/lib/constants";
import type { EncryptedExportFile } from "@/lib/export-crypto";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Upload, Loader2, FileUp, CheckCircle2, AlertCircle, Lock } from "lucide-react";
import { formatLabels, type CsvFormat, type ParsedEntry } from "@/components/passwords/import-dialog-utils";
import type { ImportTranslator } from "@/components/passwords/import-dialog-types";

function entryTypeLabel(t: ImportTranslator, entryType: string): string {
  if (entryType === ENTRY_TYPE.PASSKEY) return t("typePasskey");
  if (entryType === ENTRY_TYPE.IDENTITY) return t("typeIdentity");
  if (entryType === ENTRY_TYPE.CREDIT_CARD) return t("typeCard");
  if (entryType === ENTRY_TYPE.SECURE_NOTE) return t("typeNote");
  return t("typeLogin");
}

interface ImportDoneStepProps {
  t: ImportTranslator;
  successCount: number;
  onReset: () => void;
}

export function ImportDoneStep({ t, successCount, onReset }: ImportDoneStepProps) {
  return (
    <div className="flex flex-col items-center gap-3 py-6">
      <CheckCircle2 className="h-10 w-10 text-green-500" />
      <p className="text-sm text-muted-foreground">{t("importedCount", { count: successCount })}</p>
      <Button type="button" onClick={onReset}>
        {t("importAnother")}
      </Button>
    </div>
  );
}

interface ImportDecryptStepProps {
  t: ImportTranslator;
  decryptPassword: string;
  decryptError: string;
  decrypting: boolean;
  onReset: () => void;
  onDecrypt: () => void;
  onDecryptPasswordChange: (value: string) => void;
  encryptedFile: EncryptedExportFile | null;
}

export function ImportDecryptStep({
  t,
  decryptPassword,
  decryptError,
  decrypting,
  onReset,
  onDecrypt,
  onDecryptPasswordChange,
  encryptedFile,
}: ImportDecryptStepProps) {
  if (!encryptedFile) return null;
  return (
    <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <div className="flex items-start gap-3 rounded-lg border border-blue-500/30 bg-blue-500/10 p-3">
        <Lock className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
        <p className="text-sm text-blue-800 dark:text-blue-200">{t("encryptedFileDetected")}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="decrypt-password" className="text-sm">
          {t("decryptPassword")}
        </Label>
        <Input
          id="decrypt-password"
          type="password"
          value={decryptPassword}
          onChange={(e) => onDecryptPasswordChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && decryptPassword) onDecrypt();
          }}
          autoComplete="off"
          autoFocus
        />
      </div>
      {decryptError && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
          <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-xs text-destructive">{decryptError}</p>
        </div>
      )}
      <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:justify-end sm:gap-2">
        <Button variant="outline" onClick={onReset} disabled={decrypting}>
          {t("back")}
        </Button>
        <Button onClick={onDecrypt} disabled={decrypting || !decryptPassword}>
          {decrypting ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Lock className="h-4 w-4 mr-2" />
          )}
          {decrypting ? t("decrypting") : t("decryptButton")}
        </Button>
      </div>
    </div>
  );
}

interface ImportFileSelectStepProps {
  t: ImportTranslator;
  dragOver: boolean;
  fileRef: RefObject<HTMLInputElement | null>;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function ImportFileSelectStep({
  t,
  dragOver,
  fileRef,
  onDragOver,
  onDragLeave,
  onDrop,
  onFileChange,
}: ImportFileSelectStepProps) {
  return (
    <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <p className="text-sm text-muted-foreground">{t("supportedFormats")}</p>
      <label
        className={`flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 transition-colors ${
          dragOver ? "border-primary bg-primary/10" : "hover:bg-muted/60"
        }`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <FileUp className={`h-8 w-8 ${dragOver ? "text-primary" : "text-muted-foreground"}`} />
        <span className="text-sm text-muted-foreground">{t("selectFile")}</span>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.json"
          className="hidden"
          onChange={onFileChange}
        />
      </label>
    </div>
  );
}

interface ImportPreviewStepProps {
  t: ImportTranslator;
  entries: ParsedEntry[];
  format: CsvFormat;
  importing: boolean;
  progress: { current: number; total: number };
}

export function ImportPreviewStep({
  t,
  entries,
  format,
  importing,
  progress,
}: ImportPreviewStepProps) {
  return (
    <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t("detectedFormat")}:</span>
        <span className="font-medium">{formatLabels[format]}</span>
      </div>

      {format === "unknown" && (
        <div className="flex items-start gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3">
          <AlertCircle className="h-4 w-4 text-yellow-600 shrink-0 mt-0.5" />
          <p className="text-xs text-yellow-800 dark:text-yellow-200">{t("unknownFormat")}</p>
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
                <td className="px-2 py-1 text-muted-foreground">{entryTypeLabel(t, entry.entryType)}</td>
                <td className="px-2 py-1 truncate max-w-[120px]">
                  {entry.entryType === ENTRY_TYPE.LOGIN ? entry.username : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-sm text-muted-foreground">{t("entryCount", { count: entries.length })}</p>

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
  );
}

interface ImportActionsProps {
  t: ImportTranslator;
  importing: boolean;
  entriesCount: number;
  onReset: () => void;
  onImport: () => void;
}

export function ImportActions({ t, importing, entriesCount, onReset, onImport }: ImportActionsProps) {
  return (
    <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:justify-end sm:gap-2">
      <Button variant="outline" onClick={onReset} disabled={importing}>
        {t("back")}
      </Button>
      <Button onClick={onImport} disabled={importing}>
        {importing ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Upload className="h-4 w-4 mr-2" />
        )}
        {t("importButton", { count: entriesCount })}
      </Button>
    </div>
  );
}

export function buildImportAuditPayload(
  entriesCount: number,
  successCount: number,
  failedCount: number,
  sourceFilename: string,
  encryptedInput: boolean
) {
  return {
    requestedCount: entriesCount,
    successCount,
    failedCount,
    filename: sourceFilename || undefined,
    format: sourceFilename.toLowerCase().endsWith(".json") ? "json" : "csv",
    encrypted: encryptedInput,
  };
}

export function fireImportAudit(
  entriesCount: number,
  successCount: number,
  failedCount: number,
  sourceFilename: string,
  encryptedInput: boolean
) {
  fetch(API_PATH.AUDIT_LOGS_IMPORT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      buildImportAuditPayload(entriesCount, successCount, failedCount, sourceFilename, encryptedInput)
    ),
  }).catch(() => {});
}
