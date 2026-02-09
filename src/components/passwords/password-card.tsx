"use client";

import { useState, useEffect } from "react";

import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TagBadge } from "@/components/tags/tag-badge";
import { CopyButton } from "./copy-button";
import { Favicon } from "./favicon";
import {
  PasswordDetailInline,
  type InlineDetailData,
} from "./password-detail-inline";
import type { TOTPEntry } from "./totp-field";
import { PasswordEditDialog } from "./password-edit-dialog";
import {
  User,
  Star,
  MoreVertical,
  Copy,
  ExternalLink,
  Edit,
  Archive,
  ArchiveRestore,
  Trash2,
  ChevronRight,
  ChevronDown,
  Loader2,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import { useVault } from "@/lib/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";

interface PasswordCardProps {
  id: string;
  entryType?: "LOGIN" | "SECURE_NOTE";
  title: string;
  username: string | null;
  urlHost: string | null;
  snippet?: string | null;
  tags: Array<{ name: string; color: string | null }>;
  isFavorite: boolean;
  isArchived: boolean;
  expanded: boolean;
  onToggleFavorite: (id: string, current: boolean) => void;
  onToggleArchive: (id: string, current: boolean) => void;
  onDelete: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onRefresh: () => void;
  // Optional: data providers for org mode (skip E2E decryption)
  getPassword?: () => Promise<string>;
  getDetail?: () => Promise<InlineDetailData>;
  getUrl?: () => Promise<string | null>;
  // Optional: custom edit handler (e.g. org edit dialog)
  onEditClick?: () => void;
  // Optional: RBAC permission control
  canEdit?: boolean;
  canDelete?: boolean;
  // Optional: additional info display
  createdBy?: string | null;
}

interface VaultEntryFull {
  title: string;
  username?: string | null;
  password?: string;
  url?: string | null;
  notes?: string | null;
  content?: string;
  tags: Array<{ name: string; color: string | null }>;
  customFields?: Array<{ label: string; value: string; type: "text" | "hidden" | "url" }>;
  passwordHistory?: Array<{ password: string; changedAt: string }>;
  totp?: TOTPEntry;
}

const CLIPBOARD_CLEAR_DELAY = 30_000;

export function PasswordCard({
  id,
  entryType = "LOGIN",
  title,
  username,
  urlHost,
  snippet,
  tags,
  isFavorite,
  isArchived,
  expanded,
  onToggleFavorite,
  onToggleArchive,
  onDelete,
  onToggleExpand,
  onRefresh,
  getPassword: getPasswordProp,
  getDetail: getDetailProp,
  getUrl: getUrlProp,
  onEditClick,
  canEdit = true,
  canDelete = true,
  createdBy,
}: PasswordCardProps) {
  const isOrgMode = !!getPasswordProp;
  const isNote = entryType === "SECURE_NOTE";
  const t = useTranslations("PasswordCard");
  const tc = useTranslations("Common");
  const tCopy = useTranslations("CopyButton");
  const { encryptionKey } = useVault();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [detailData, setDetailData] = useState<InlineDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchDecryptedEntry = async (): Promise<{ entry: VaultEntryFull; raw: Record<string, unknown> }> => {
    if (!encryptionKey) throw new Error("Vault locked");
    const res = await fetch(`/api/passwords/${id}`);
    if (!res.ok) throw new Error("Failed to fetch");
    const raw = await res.json();
    const plaintext = await decryptData(
      raw.encryptedBlob as EncryptedData,
      encryptionKey
    );
    return { entry: JSON.parse(plaintext), raw };
  };

  const fetchPassword = async (): Promise<string> => {
    if (getPasswordProp) return getPasswordProp();
    const { entry } = await fetchDecryptedEntry();
    return entry.password ?? "";
  };

  const fetchContent = async (): Promise<string> => {
    const { entry } = await fetchDecryptedEntry();
    return entry.content ?? "";
  };

  // Fetch detail data when expanded
  useEffect(() => {
    if (!expanded || detailData) return;

    let cancelled = false;
    setDetailLoading(true);

    if (getDetailProp) {
      // Org mode: use provided data fetcher
      getDetailProp()
        .then((detail) => {
          if (!cancelled) setDetailData(detail);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setDetailLoading(false);
        });
    } else {
      // Personal mode: E2E decrypt
      fetchDecryptedEntry()
        .then(({ entry, raw }) => {
          if (cancelled) return;
          setDetailData({
            id,
            entryType,
            password: entry.password ?? "",
            content: entry.content,
            url: entry.url ?? null,
            urlHost,
            notes: entry.notes ?? null,
            customFields: entry.customFields ?? [],
            passwordHistory: entry.passwordHistory ?? [],
            totp: entry.totp,
            createdAt: raw.createdAt as string,
            updatedAt: raw.updatedAt as string,
          });
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setDetailLoading(false);
        });
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const handleCopyContent = async () => {
    try {
      const content = await fetchContent();
      await navigator.clipboard.writeText(content);
      toast.success(tCopy("copied"));
      setTimeout(async () => {
        try {
          await navigator.clipboard.writeText("");
        } catch {}
      }, CLIPBOARD_CLEAR_DELAY);
    } catch {
      toast.error(t("networkError"));
    }
  };

  const handleCopyUsername = async () => {
    if (!username) return;
    try {
      await navigator.clipboard.writeText(username);
      toast.success(tCopy("copied"));
      setTimeout(async () => {
        try {
          await navigator.clipboard.writeText("");
        } catch {}
      }, CLIPBOARD_CLEAR_DELAY);
    } catch {}
  };

  const handleCopyPassword = async () => {
    try {
      const pw = await fetchPassword();
      await navigator.clipboard.writeText(pw);
      toast.success(tCopy("copied"));
      setTimeout(async () => {
        try {
          await navigator.clipboard.writeText("");
        } catch {}
      }, CLIPBOARD_CLEAR_DELAY);
    } catch {
      toast.error(t("networkError"));
    }
  };

  const handleOpenUrl = async () => {
    try {
      if (getUrlProp) {
        const url = await getUrlProp();
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      } else {
        const { entry } = await fetchDecryptedEntry();
        if (entry.url) window.open(entry.url, "_blank", "noopener,noreferrer");
      }
    } catch {
      toast.error(t("networkError"));
    }
  };

  return (
    <>
      <Card className="transition-colors">
        <CardContent className="flex items-center gap-4 p-4">
          <button
            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => onToggleExpand(id)}
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={(e) => {
              e.preventDefault();
              onToggleFavorite(id, isFavorite);
            }}
          >
            <Star
              className={`h-4 w-4 ${isFavorite ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"}`}
            />
          </Button>
          {isNote ? (
            <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          ) : (
            <Favicon host={urlHost} size={20} className="shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <button
              className="font-medium hover:underline truncate block text-left"
              onClick={() => onToggleExpand(id)}
            >
              {title}
            </button>
            <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
              {isNote ? (
                snippet && (
                  <span className="truncate">{snippet}</span>
                )
              ) : (
                <>
                  {username && (
                    <span className="flex items-center gap-1 truncate">
                      <User className="h-3 w-3 shrink-0" />
                      {username}
                    </span>
                  )}
                  {urlHost && (
                    <span className="truncate">
                      {urlHost}
                    </span>
                  )}
                </>
              )}
              {createdBy && (
                <span className="truncate text-xs">
                  {createdBy}
                </span>
              )}
            </div>
          </div>
          {tags.length > 0 && (
            <div className="flex gap-1 shrink-0">
              {tags.map((tag) => (
                <TagBadge key={tag.name} name={tag.name} color={tag.color} />
              ))}
            </div>
          )}
          {!isNote && <CopyButton getValue={fetchPassword} />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
                <MoreVertical className="h-4 w-4" />
                <span className="sr-only">{t("moreActions")}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isNote ? (
                <DropdownMenuItem onSelect={handleCopyContent}>
                  <Copy className="h-4 w-4" />
                  {t("copyContent")}
                </DropdownMenuItem>
              ) : (
                <>
                  {username && (
                    <DropdownMenuItem onSelect={handleCopyUsername}>
                      <User className="h-4 w-4" />
                      {t("copyUsername")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={handleCopyPassword}>
                    <Copy className="h-4 w-4" />
                    {t("copyPassword")}
                  </DropdownMenuItem>
                  {urlHost && (
                    <DropdownMenuItem onSelect={handleOpenUrl}>
                      <ExternalLink className="h-4 w-4" />
                      {t("openUrl")}
                    </DropdownMenuItem>
                  )}
                </>
              )}
              {canEdit && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => {
                      if (onEditClick) onEditClick();
                      else setEditDialogOpen(true);
                    }}
                  >
                    <Edit className="h-4 w-4" />
                    {t("edit")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      onToggleArchive(id, isArchived);
                      toast.success(isArchived ? t("unarchived") : t("archived"));
                    }}
                  >
                    {isArchived ? (
                      <ArchiveRestore className="h-4 w-4" />
                    ) : (
                      <Archive className="h-4 w-4" />
                    )}
                    {isArchived ? t("unarchive") : t("archive")}
                  </DropdownMenuItem>
                </>
              )}
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={(e) => {
                      e.preventDefault();
                      setDeleteDialogOpen(true);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t("delete")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </CardContent>

        {/* Expanded inline detail */}
        {expanded && (
          detailLoading ? (
            <div className="flex items-center justify-center py-6 border-t">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : detailData ? (
            <PasswordDetailInline
              data={detailData}
              onEdit={canEdit ? () => {
                if (onEditClick) onEditClick();
                else setEditDialogOpen(true);
              } : undefined}
            />
          ) : null
        )}
      </Card>

      {!isOrgMode && (
        <PasswordEditDialog
          id={id}
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          onSaved={() => {
            setDetailData(null);
            onRefresh();
          }}
        />
      )}

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("delete")}</DialogTitle>
            <DialogDescription>
              {t("deleteConfirm", { title })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
            >
              {tc("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setDeleteDialogOpen(false);
                onDelete(id);
                toast.success(t("deleted"));
              }}
            >
              {tc("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
