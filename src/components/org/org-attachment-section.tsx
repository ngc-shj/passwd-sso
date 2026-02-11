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
import { apiErrorToI18nKey } from "@/lib/api-error-codes";
import {
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
  MAX_ATTACHMENTS_PER_ENTRY,
} from "@/lib/validations";

export interface OrgAttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

interface OrgAttachmentSectionProps {
  orgId: string;
  entryId: string;
  attachments: OrgAttachmentMeta[];
  onAttachmentsChange: (attachments: OrgAttachmentMeta[]) => void;
  readOnly?: boolean;
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

export function OrgAttachmentSection({
  orgId,
  entryId,
  attachments,
  onAttachmentsChange,
  readOnly = false,
}: OrgAttachmentSectionProps) {
  const t = useTranslations("Attachments");
  const tApi = useTranslations("ApiErrors");
  const tc = useTranslations("Common");
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OrgAttachmentMeta | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (fileInputRef.current) fileInputRef.current.value = "";

    // Validate size
    if (file.size > MAX_FILE_SIZE) {
      toast.error(t("fileTooLarge", { max: formatFileSize(MAX_FILE_SIZE) }));
      return;
    }

    if (attachments.length >= MAX_ATTACHMENTS_PER_ENTRY) {
      toast.error(t("tooManyFiles", { max: MAX_ATTACHMENTS_PER_ENTRY }));
      return;
    }

    setUploading(true);
    try {
      // Org: send plaintext file — server encrypts
      const formData = new FormData();
      formData.append("file", file);
      formData.append("filename", file.name);
      formData.append("contentType", file.type);

      const res = await fetch(
        `/api/orgs/${orgId}/passwords/${entryId}/attachments`,
        { method: "POST", body: formData }
      );

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(tApi(apiErrorToI18nKey(err?.error)));
        return;
      }

      const newAttachment: OrgAttachmentMeta = await res.json();
      onAttachmentsChange([newAttachment, ...attachments]);
      toast.success(t("uploaded"));
    } catch {
      toast.error(t("uploadError"));
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (attachment: OrgAttachmentMeta) => {
    setDownloading(attachment.id);
    try {
      // Org: server decrypts and returns plaintext binary
      const res = await fetch(
        `/api/orgs/${orgId}/passwords/${entryId}/attachments/${attachment.id}`
      );
      if (!res.ok) throw new Error("Download failed");

      const blob = await res.blob();
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
        `/api/orgs/${orgId}/passwords/${entryId}/attachments/${deleteTarget.id}`,
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
