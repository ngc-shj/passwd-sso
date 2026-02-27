"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { ParsedEntry } from "@/components/passwords/password-import-utils";
import type { ImportTranslator } from "@/components/passwords/password-import-types";
import { runImportEntries } from "@/components/passwords/password-import-importer";
import { fireImportAudit } from "@/components/passwords/password-import-steps";

interface UseImportExecutionParams {
  t: ImportTranslator;
  onComplete: () => void;
  isTeamImport: boolean;
  tagsPath: string;
  passwordsPath: string;
  sourceFilename: string;
  encryptedInput: boolean;
  userId?: string;
  encryptionKey?: CryptoKey;
  teamEncryptionKey?: CryptoKey;
  teamKeyVersion?: number;
  teamId?: string;
}

interface ImportResult {
  success: number;
  failed: number;
}

interface UseImportExecutionResult {
  importing: boolean;
  progress: { current: number; total: number };
  done: boolean;
  result: ImportResult;
  resetExecution: () => void;
  runImport: (entries: ParsedEntry[]) => Promise<void>;
}

export function useImportExecution({
  t,
  onComplete,
  isTeamImport,
  tagsPath,
  passwordsPath,
  sourceFilename,
  encryptedInput,
  userId,
  encryptionKey,
  teamEncryptionKey,
  teamKeyVersion,
  teamId,
}: UseImportExecutionParams): UseImportExecutionResult {
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [done, setDone] = useState(false);
  const [result, setResult] = useState<ImportResult>({ success: 0, failed: 0 });

  const resetExecution = () => {
    setImporting(false);
    setProgress({ current: 0, total: 0 });
    setDone(false);
    setResult({ success: 0, failed: 0 });
  };

  const runImport = async (entries: ParsedEntry[]) => {
    if (entries.length === 0) return;
    if (!isTeamImport && !encryptionKey) return;
    if (isTeamImport && !teamEncryptionKey) return;

    setImporting(true);
    setProgress({ current: 0, total: entries.length });
    try {
      const { successCount, failedCount } = await runImportEntries({
        entries,
        isTeamImport,
        tagsPath,
        passwordsPath,
        sourceFilename,
        userId,
        encryptionKey: encryptionKey ?? undefined,
        teamEncryptionKey: teamEncryptionKey ?? undefined,
        teamKeyVersion,
        teamId,
        onProgress: (current, total) => setProgress({ current, total }),
      });

      setDone(true);
      setResult({ success: successCount, failed: failedCount });

      if (!isTeamImport) {
        fireImportAudit(entries.length, successCount, failedCount, sourceFilename, encryptedInput);
      }

      if (successCount > 0) {
        toast.success(t("importedCount", { count: successCount }));
        onComplete();
      }
    } finally {
      setImporting(false);
    }
  };

  return {
    importing,
    progress,
    done,
    result,
    resetExecution,
    runImport,
  };
}
