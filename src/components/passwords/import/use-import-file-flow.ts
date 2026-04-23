"use client";

import { useRef, useState } from "react";
import {
  isEncryptedExport,
  decryptExport,
  type EncryptedExportFile,
} from "@/lib/crypto/export-crypto";
import {
  parseCsv,
  parseJson,
  parseKeePassXcXml,
  type CsvFormat,
  type ParsedEntry,
} from "@/components/passwords/import/password-import-utils";

interface UseImportFileFlowResult {
  fileRef: React.RefObject<HTMLInputElement | null>;
  entries: ParsedEntry[];
  format: CsvFormat;
  dragOver: boolean;
  encryptedFile: EncryptedExportFile | null;
  decryptPassword: string;
  decrypting: boolean;
  decryptError: string;
  sourceFilename: string;
  encryptedInput: boolean;
  setDragOver: (value: boolean) => void;
  setDecryptPasswordAndClearError: (value: string) => void;
  handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleDrop: (e: React.DragEvent) => void;
  handleDecrypt: (decryptFailedMessage: string) => Promise<void>;
  reset: () => void;
}

export function useImportFileFlow(): UseImportFileFlowResult {
  const fileRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<ParsedEntry[]>([]);
  const [format, setFormat] = useState<CsvFormat>("unknown");
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
    setDragOver(false);
    setEncryptedFile(null);
    setDecryptPassword("");
    setDecrypting(false);
    setDecryptError("");
    setSourceFilename("");
    setEncryptedInput(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const parseContent = (text: string, fileType: "json" | "xml" | "csv") => {
    if (fileType === "json") {
      const result = parseJson(text);
      setEntries(result.entries);
      setFormat(result.format);
      return;
    }
    if (fileType === "xml") {
      const result = parseKeePassXcXml(text);
      setEntries(result.entries);
      setFormat(result.format);
      return;
    }
    const result = parseCsv(text);
    setEntries(result.entries);
    setFormat(result.format);
  };

  const loadFile = (file: File) => {
    setSourceFilename(file.name);
    const lowerName = file.name.toLowerCase();
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;

      if (lowerName.endsWith(".xml")) {
        parseContent(text, "xml");
        return;
      }

      if (lowerName.endsWith(".json")) {
        try {
          const parsed = JSON.parse(text);
          if (isEncryptedExport(parsed)) {
            setEncryptedFile(parsed);
            setEncryptedInput(true);
            return;
          }
        } catch {
          // Not valid JSON, fall through to regular parsing.
        }
        parseContent(text, "json");
        return;
      }

      parseContent(text, "csv");
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
    const lowerName = file?.name.toLowerCase() ?? "";
    if (file && (lowerName.endsWith(".csv") || lowerName.endsWith(".json") || lowerName.endsWith(".xml"))) {
      loadFile(file);
    }
  };

  const handleDecrypt = async (decryptFailedMessage: string) => {
    if (!encryptedFile) return;
    setDecrypting(true);
    setDecryptError("");

    try {
      const { plaintext, format: originalFormat } = await decryptExport(
        encryptedFile,
        decryptPassword
      );
      parseContent(plaintext, originalFormat === "json" ? "json" : "csv");
      setEncryptedFile(null);
      setDecryptPassword("");
    } catch {
      setDecryptError(decryptFailedMessage);
    } finally {
      setDecrypting(false);
    }
  };

  return {
    fileRef,
    entries,
    format,
    dragOver,
    encryptedFile,
    decryptPassword,
    decrypting,
    decryptError,
    sourceFilename,
    encryptedInput,
    setDragOver,
    setDecryptPasswordAndClearError: (value: string) => {
      setDecryptPassword(value);
      setDecryptError("");
    },
    handleFileChange,
    handleDrop,
    handleDecrypt,
    reset,
  };
}
