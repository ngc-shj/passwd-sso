"use client";

import { useState, useRef } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Download,
  Trash2,
  Upload,
  Loader2,
  Paperclip,
  FileText,
  ImageIcon,
  File,
} from "lucide-react";
import { toast } from "sonner";
import { toastApiError } from "@/lib/http/toast-api-error";
import { useVault } from "@/lib/vault/vault-context";
import {
  encryptBinary,
  decryptBinary,
  type EncryptedBinary,
} from "@/lib/crypto/crypto-client";
import {
  buildAttachmentAAD,
  buildAttachmentCekWrapAAD,
  AAD_VERSION,
  MIN_ACCEPTED_CEK_WRAP_AAD_VERSION,
  CURRENT_CEK_WRAP_AAD_VERSION,
} from "@/lib/crypto/crypto-aad";
import { apiPath } from "@/lib/constants";
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_CONTENT_TYPES,
  MAX_FILE_SIZE,
  MAX_ATTACHMENTS_PER_ENTRY,
} from "@/lib/validations";
import { fetchApi } from "@/lib/url-helpers";

export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  encryptionMode?: number;
}

interface AttachmentSectionProps {
  entryId: string;
  attachments: AttachmentMeta[];
  onAttachmentsChange: (attachments: AttachmentMeta[]) => void;
  readOnly?: boolean;
  keyVersion?: number;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(contentType: string) {
  if (contentType.startsWith("image/")) return ImageIcon;
  if (contentType === "application/pdf") return FileText;
  return File;
}

function getExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

/** Download response shape from GET /api/passwords/[id]/attachments/[attachmentId] */
interface Mode0AttachmentDownload {
  encryptionMode: 0;
  encryptedData: string; // base64
  iv: string;
  authTag: string;
  aadVersion: number;
  cekEncrypted: null;
  cekIv: null;
  cekAuthTag: null;
  cekKeyVersion: null;
  cekWrapAadVersion: null;
}

interface Mode2AttachmentDownload {
  encryptionMode: 2;
  encryptedData: string; // base64
  iv: string;
  authTag: string;
  aadVersion: number;
  cekEncrypted: string; // base64
  cekIv: string;
  cekAuthTag: string;
  cekKeyVersion: number;
  cekWrapAadVersion: number;
}

type AttachmentDownload = Mode0AttachmentDownload | Mode2AttachmentDownload;

/** Decode a base64 string to a Uint8Array. */
function base64ToBytes(b64: string): Uint8Array {
  const binaryStr = atob(b64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

/** Encode a Uint8Array to a base64 string. */
function bytesToBase64(bytes: Uint8Array): string {
  let binaryStr = "";
  for (const b of bytes) {
    binaryStr += String.fromCharCode(b);
  }
  return btoa(binaryStr);
}

export function AttachmentSection({
  entryId,
  attachments,
  onAttachmentsChange,
  readOnly = false,
  keyVersion,
}: AttachmentSectionProps) {
  const t = useTranslations("Attachments");
  const tVault = useTranslations("Vault");
  const tApi = useTranslations("ApiErrors");
  const tc = useTranslations("Common");
  const { encryptionKey, getKeyVersion } = useVault();
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AttachmentMeta | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !encryptionKey) return;

    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = "";

    // Validate extension
    const ext = getExtension(file.name);
    if (!ALLOWED_EXTENSIONS.includes(ext as typeof ALLOWED_EXTENSIONS[number])) {
      toast.error(t("invalidExtension", { allowed: ALLOWED_EXTENSIONS.join(", ") }));
      return;
    }

    // Validate content type
    if (!ALLOWED_CONTENT_TYPES.includes(file.type as typeof ALLOWED_CONTENT_TYPES[number])) {
      toast.error(t("invalidContentType"));
      return;
    }

    // Validate size
    if (file.size > MAX_FILE_SIZE) {
      toast.error(t("fileTooLarge", { max: formatFileSize(MAX_FILE_SIZE) }));
      return;
    }

    // Validate count
    if (attachments.length >= MAX_ATTACHMENTS_PER_ENTRY) {
      toast.error(t("tooManyFiles", { max: MAX_ATTACHMENTS_PER_ENTRY }));
      return;
    }

    setUploading(true);
    try {
      // Read file as ArrayBuffer
      const arrayBuffer = await file.arrayBuffer();

      // Pre-generate attachment ID for AAD binding
      const attachmentId = crypto.randomUUID();
      const currentKeyVersion = keyVersion ?? getKeyVersion();

      // Mode-2: generate a fresh CEK, encrypt body under CEK, wrap CEK with vault key.
      // Use exportKey("raw") + manual AES-GCM — do NOT use crypto.subtle.wrapKey (I8.1).
      const cek = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );

      // Encrypt file body under CEK using the data AAD
      const dataAad = buildAttachmentAAD(entryId, attachmentId);
      const encrypted: EncryptedBinary = await encryptBinary(arrayBuffer, cek, dataAad);

      // Export raw CEK bytes, wrap with vault encryptionKey
      const cekRaw = await crypto.subtle.exportKey("raw", cek);
      const cekRawBytes = new Uint8Array(cekRaw);
      const wrapAad = buildAttachmentCekWrapAAD(entryId, attachmentId, currentKeyVersion, 1);
      const wrappedCek: EncryptedBinary = await encryptBinary(
        cekRawBytes.buffer.slice(
          cekRawBytes.byteOffset,
          cekRawBytes.byteOffset + cekRawBytes.byteLength,
        ) as ArrayBuffer,
        encryptionKey,
        wrapAad,
      );
      // Zeroize raw CEK bytes after use
      cekRawBytes.fill(0);

      // Build FormData with encrypted blob
      const formData = new FormData();
      formData.append("id", attachmentId);
      formData.append("file", new Blob([encrypted.ciphertext.buffer.slice(0) as ArrayBuffer]));
      formData.append("iv", encrypted.iv);
      formData.append("authTag", encrypted.authTag);
      formData.append("filename", file.name);
      formData.append("contentType", file.type);
      formData.append("sizeBytes", file.size.toString());
      formData.append("aadVersion", String(AAD_VERSION));
      formData.append("encryptionMode", "2");
      formData.append("cekEncrypted", bytesToBase64(wrappedCek.ciphertext));
      formData.append("cekIv", wrappedCek.iv);
      formData.append("cekAuthTag", wrappedCek.authTag);
      formData.append("cekKeyVersion", String(currentKeyVersion));
      formData.append("cekWrapAadVersion", String(CURRENT_CEK_WRAP_AAD_VERSION));
      if (keyVersion) formData.append("keyVersion", keyVersion.toString());

      const res = await fetchApi(apiPath.passwordAttachments(entryId), {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        await toastApiError(res, tApi);
        return;
      }

      const newAttachment: AttachmentMeta = await res.json();
      onAttachmentsChange([newAttachment, ...attachments]);
      toast.success(t("uploaded"));
    } catch {
      toast.error(t("uploadError"));
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (attachment: AttachmentMeta) => {
    if (!encryptionKey) return;

    setDownloading(attachment.id);
    try {
      const res = await fetchApi(
        apiPath.passwordAttachmentById(entryId, attachment.id)
      );
      if (!res.ok) {
        throw new Error("Download failed");
      }

      const data = (await res.json()) as AttachmentDownload;

      // Decode base64 encrypted body
      const ciphertext = base64ToBytes(data.encryptedData);
      const dataAad = data.aadVersion >= 1
        ? buildAttachmentAAD(entryId, attachment.id)
        : undefined;

      let decrypted: ArrayBuffer;

      if (data.encryptionMode === 0) {
        // Legacy: body encrypted directly with vault encryptionKey
        decrypted = await decryptBinary(
          { ciphertext, iv: data.iv, authTag: data.authTag },
          encryptionKey,
          dataAad,
        );
      } else {
        // Mode-2: unwrap CEK, then decrypt body with CEK
        if (data.cekWrapAadVersion < MIN_ACCEPTED_CEK_WRAP_AAD_VERSION) {
          toast.error(tVault("outdatedAttachmentFormat"));
          return;
        }
        const cekWrapAad = buildAttachmentCekWrapAAD(
          entryId,
          attachment.id,
          data.cekKeyVersion,
          data.cekWrapAadVersion,
        );
        const cekEncryptedBytes = base64ToBytes(data.cekEncrypted);
        const cekRaw = await decryptBinary(
          { ciphertext: cekEncryptedBytes, iv: data.cekIv, authTag: data.cekAuthTag },
          encryptionKey,
          cekWrapAad,
        );
        const cek = await crypto.subtle.importKey(
          "raw",
          cekRaw,
          { name: "AES-GCM", length: 256 },
          false,
          ["decrypt"],
        );
        decrypted = await decryptBinary(
          { ciphertext, iv: data.iv, authTag: data.authTag },
          cek,
          dataAad,
        );
      }

      // Trigger download
      const blob = new Blob([decrypted], { type: attachment.contentType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = attachment.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      toast.error(t("downloadError"));
    } finally {
      setDownloading(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;

    setDeleting(true);
    try {
      const res = await fetchApi(
        apiPath.passwordAttachmentById(entryId, deleteTarget.id),
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error("Delete failed");

      onAttachmentsChange(attachments.filter((a) => a.id !== deleteTarget.id));
      toast.success(t("deleted"));
    } catch {
      toast.error(t("deleteError"));
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  if (readOnly && attachments.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm text-muted-foreground flex items-center gap-1">
          <Paperclip className="h-3.5 w-3.5" />
          {t("title")}
          {attachments.length > 0 && (
            <span className="text-xs">({attachments.length})</span>
          )}
        </label>
        {!readOnly && (
          <div>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept={ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",")}
              onChange={handleUpload}
              disabled={uploading}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || attachments.length >= MAX_ATTACHMENTS_PER_ENTRY}
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Upload className="h-4 w-4 mr-1" />
              )}
              {t("upload")}
            </Button>
          </div>
        )}
      </div>

      {attachments.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-background/70 p-4 text-center">
          <p className="text-sm text-muted-foreground">{t("noAttachments")}</p>
        </div>
      ) : (
        <div className="space-y-1">
          {attachments.map((att) => {
            const Icon = getFileIcon(att.contentType);
            return (
              <div
                key={att.id}
                className="flex items-center gap-2 rounded-lg border bg-background/80 px-3 py-2"
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{att.filename}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatFileSize(att.sizeBytes)}
                  </p>
                  {att.encryptionMode === 0 && (
                    <p className="text-xs text-muted-foreground/70 italic">
                      {tVault("legacyAttachmentHint")}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => handleDownload(att)}
                  disabled={downloading === att.id}
                  title={t("download")}
                >
                  {downloading === att.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                </Button>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => setDeleteTarget(att)}
                    title={tc("delete")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmDeleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmDeleteDescription", { filename: deleteTarget?.filename ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {tc("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {tc("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
