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
import { useVault } from "@/lib/vault-context";
import {
  encryptBinary,
  decryptBinary,
  hexEncode,
  type EncryptedBinary,
} from "@/lib/crypto-client";
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_CONTENT_TYPES,
  MAX_FILE_SIZE,
  MAX_ATTACHMENTS_PER_ENTRY,
} from "@/lib/validations";

export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
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

export function AttachmentSection({
  entryId,
  attachments,
  onAttachmentsChange,
  readOnly = false,
  keyVersion,
}: AttachmentSectionProps) {
  const t = useTranslations("Attachments");
  const tc = useTranslations("Common");
  const { encryptionKey } = useVault();
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

      // Encrypt client-side
      const encrypted: EncryptedBinary = await encryptBinary(arrayBuffer, encryptionKey);

      // Build FormData with encrypted blob
      const formData = new FormData();
      formData.append("file", new Blob([encrypted.ciphertext.buffer.slice(0) as ArrayBuffer]));
      formData.append("iv", encrypted.iv);
      formData.append("authTag", encrypted.authTag);
      formData.append("filename", file.name);
      formData.append("contentType", file.type);
      formData.append("sizeBytes", file.size.toString());
      if (keyVersion) formData.append("keyVersion", keyVersion.toString());

      const res = await fetch(`/api/passwords/${entryId}/attachments`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(err.error || "Upload failed");
      }

      const newAttachment: AttachmentMeta = await res.json();
      onAttachmentsChange([newAttachment, ...attachments]);
      toast.success(t("uploaded"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("uploadError"));
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (attachment: AttachmentMeta) => {
    if (!encryptionKey) return;

    setDownloading(attachment.id);
    try {
      const res = await fetch(
        `/api/passwords/${entryId}/attachments/${attachment.id}`
      );
      if (!res.ok) throw new Error("Download failed");

      const data = await res.json();

      // Decode base64 encrypted data
      const binaryStr = atob(data.encryptedData);
      const ciphertext = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        ciphertext[i] = binaryStr.charCodeAt(i);
      }

      // Decrypt client-side
      const decrypted = await decryptBinary(
        { ciphertext, iv: data.iv, authTag: data.authTag },
        encryptionKey
      );

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
      const res = await fetch(
        `/api/passwords/${entryId}/attachments/${deleteTarget.id}`,
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
        <p className="text-sm text-muted-foreground py-2">{t("noAttachments")}</p>
      ) : (
        <div className="space-y-1">
          {attachments.map((att) => {
            const Icon = getFileIcon(att.contentType);
            return (
              <div
                key={att.id}
                className="flex items-center gap-2 rounded-md bg-muted px-3 py-2"
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{att.filename}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatFileSize(att.sizeBytes)}
                  </p>
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
