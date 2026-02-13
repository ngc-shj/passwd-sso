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
  CreditCard,
  IdCard,
  Fingerprint,
  Link as LinkIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useVault } from "@/lib/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD } from "@/lib/crypto-aad";
import { ShareDialog } from "@/components/share/share-dialog";
import { ENTRY_TYPE, apiPath } from "@/lib/constants";
import type { EntryTypeValue, CustomFieldType } from "@/lib/constants";

interface PasswordCardProps {
  id: string;
  entryType?: EntryTypeValue;
  title: string;
  username: string | null;
  urlHost: string | null;
  snippet?: string | null;
  brand?: string | null;
  lastFour?: string | null;
  cardholderName?: string | null;
  fullName?: string | null;
  idNumberLast4?: string | null;
  relyingPartyId?: string | null;
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
  // Optional: org context for share dialog
  orgId?: string;
}

interface VaultEntryFull {
  title: string;
  username?: string | null;
  password?: string;
  url?: string | null;
  notes?: string | null;
  content?: string;
  tags: Array<{ name: string; color: string | null }>;
  customFields?: Array<{ label: string; value: string; type: CustomFieldType }>;
  passwordHistory?: Array<{ password: string; changedAt: string }>;
  totp?: TOTPEntry;
  cardholderName?: string | null;
  cardNumber?: string | null;
  brand?: string | null;
  expiryMonth?: string | null;
  expiryYear?: string | null;
  cvv?: string | null;
  fullName?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  dateOfBirth?: string | null;
  nationality?: string | null;
  idNumber?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  relyingPartyId?: string | null;
  relyingPartyName?: string | null;
  credentialId?: string | null;
  creationDate?: string | null;
  deviceInfo?: string | null;
}

const CLIPBOARD_CLEAR_DELAY = 30_000;

export function PasswordCard({
  id,
  entryType = ENTRY_TYPE.LOGIN,
  title,
  username,
  urlHost,
  snippet,
  brand,
  lastFour,
  cardholderName,
  fullName,
  idNumberLast4,
  relyingPartyId,
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
  orgId,
}: PasswordCardProps) {
  const isOrgMode = !!getPasswordProp;
  const isNote = entryType === ENTRY_TYPE.SECURE_NOTE;
  const isCreditCard = entryType === ENTRY_TYPE.CREDIT_CARD;
  const isIdentity = entryType === ENTRY_TYPE.IDENTITY;
  const isPasskey = entryType === ENTRY_TYPE.PASSKEY;
  const t = useTranslations("PasswordCard");
  const tc = useTranslations("Common");
  const tCopy = useTranslations("CopyButton");
  const { encryptionKey, userId } = useVault();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareData, setShareData] = useState<Record<string, unknown> | undefined>(undefined);
  const [detailData, setDetailData] = useState<InlineDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchDecryptedEntry = async (): Promise<{ entry: VaultEntryFull; raw: Record<string, unknown> }> => {
    if (!encryptionKey) throw new Error("Vault locked");
    const res = await fetch(apiPath.passwordById(id));
    if (!res.ok) throw new Error("Failed to fetch");
    const raw = await res.json();
    const aad = raw.aadVersion >= 1 && userId
      ? buildPersonalEntryAAD(userId, id)
      : undefined;
    const plaintext = await decryptData(
      raw.encryptedBlob as EncryptedData,
      encryptionKey,
      aad
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

  const fetchIdentityField = async (field: "idNumber"): Promise<string> => {
    if (getDetailProp) {
      const detail = await getDetailProp();
      return (detail as unknown as Record<string, unknown>)[field] as string ?? "";
    }
    const { entry } = await fetchDecryptedEntry();
    return (entry as unknown as Record<string, unknown>)[field] as string ?? "";
  };

  const fetchCardField = async (field: "cardNumber" | "cvv"): Promise<string> => {
    if (getDetailProp) {
      const detail = await getDetailProp();
      return (detail as unknown as Record<string, unknown>)[field] as string ?? "";
    }
    const { entry } = await fetchDecryptedEntry();
    return (entry as unknown as Record<string, unknown>)[field] as string ?? "";
  };

  // Clear cached detail when collapsed so re-expand fetches fresh data
  useEffect(() => {
    if (!expanded) {
      setDetailData(null);
    }
  }, [expanded]);

  // Fetch detail data when expanded and no cached data
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
            cardholderName: entry.cardholderName,
            cardNumber: entry.cardNumber,
            brand: entry.brand,
            expiryMonth: entry.expiryMonth,
            expiryYear: entry.expiryYear,
            cvv: entry.cvv,
            fullName: entry.fullName,
            address: entry.address,
            phone: entry.phone,
            email: entry.email,
            dateOfBirth: entry.dateOfBirth,
            nationality: entry.nationality,
            idNumber: entry.idNumber,
            issueDate: entry.issueDate,
            expiryDate: entry.expiryDate,
            relyingPartyId: entry.relyingPartyId,
            relyingPartyName: entry.relyingPartyName,
            username: entry.username,
            credentialId: entry.credentialId,
            creationDate: entry.creationDate,
            deviceInfo: entry.deviceInfo,
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
  }, [expanded, detailData]);

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

  const handleCopyCardNumber = async () => {
    try {
      const num = await fetchCardField("cardNumber");
      if (!num) return;
      await navigator.clipboard.writeText(num);
      toast.success(tCopy("copied"));
      setTimeout(async () => {
        try { await navigator.clipboard.writeText(""); } catch {}
      }, CLIPBOARD_CLEAR_DELAY);
    } catch {
      toast.error(t("networkError"));
    }
  };

  const handleCopyCvv = async () => {
    try {
      const code = await fetchCardField("cvv");
      if (!code) return;
      await navigator.clipboard.writeText(code);
      toast.success(tCopy("copied"));
      setTimeout(async () => {
        try { await navigator.clipboard.writeText(""); } catch {}
      }, CLIPBOARD_CLEAR_DELAY);
    } catch {
      toast.error(t("networkError"));
    }
  };

  const fetchPasskeyField = async (field: "credentialId" | "username"): Promise<string> => {
    if (getDetailProp) {
      const detail = await getDetailProp();
      return (detail as unknown as Record<string, unknown>)[field] as string ?? "";
    }
    const { entry } = await fetchDecryptedEntry();
    return (entry as unknown as Record<string, unknown>)[field] as string ?? "";
  };

  const handleCopyCredentialId = async () => {
    try {
      const cid = await fetchPasskeyField("credentialId");
      if (!cid) return;
      await navigator.clipboard.writeText(cid);
      toast.success(tCopy("copied"));
      setTimeout(async () => {
        try { await navigator.clipboard.writeText(""); } catch {}
      }, CLIPBOARD_CLEAR_DELAY);
    } catch {
      toast.error(t("networkError"));
    }
  };

  const handleCopyIdNumber = async () => {
    try {
      const num = await fetchIdentityField("idNumber");
      if (!num) return;
      await navigator.clipboard.writeText(num);
      toast.success(tCopy("copied"));
      setTimeout(async () => {
        try { await navigator.clipboard.writeText(""); } catch {}
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
        <CardContent
          className="flex items-center gap-3 px-4 py-2 cursor-pointer hover:bg-muted/50 transition-colors"
          onClick={() => onToggleExpand(id)}
        >
          <div className="shrink-0 text-muted-foreground">
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(id, isFavorite);
            }}
          >
            <Star
              className={`h-4 w-4 ${isFavorite ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"}`}
            />
          </Button>
          {isPasskey ? (
            <Fingerprint className="h-5 w-5 shrink-0 text-muted-foreground" />
          ) : isIdentity ? (
            <IdCard className="h-5 w-5 shrink-0 text-muted-foreground" />
          ) : isCreditCard ? (
            <CreditCard className="h-5 w-5 shrink-0 text-muted-foreground" />
          ) : isNote ? (
            <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          ) : (
            <Favicon host={urlHost} size={20} className="shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <span className="font-medium truncate block text-left">
              {title}
            </span>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              {isPasskey ? (
                <>
                  {relyingPartyId && <span className="truncate">{relyingPartyId}</span>}
                  {username && (
                    <span className="flex items-center gap-1 truncate">
                      <User className="h-3 w-3 shrink-0" />
                      {username}
                    </span>
                  )}
                </>
              ) : isIdentity ? (
                <>
                  {fullName && <span className="truncate">{fullName}</span>}
                  {idNumberLast4 && <span className="truncate">•••• {idNumberLast4}</span>}
                </>
              ) : isCreditCard ? (
                <>
                  {brand && <span className="truncate">{brand}</span>}
                  {lastFour && <span className="truncate">•••• {lastFour}</span>}
                  {cardholderName && <span className="truncate">{cardholderName}</span>}
                </>
              ) : isNote ? (
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
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
          <div className="flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
          {!isNote && !isCreditCard && !isIdentity && !isPasskey && <CopyButton getValue={fetchPassword} />}
          {isCreditCard && <CopyButton getValue={() => fetchCardField("cardNumber")} />}
          {isIdentity && <CopyButton getValue={() => fetchIdentityField("idNumber")} />}
          {isPasskey && <CopyButton getValue={() => fetchPasskeyField("credentialId")} />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
                <MoreVertical className="h-4 w-4" />
                <span className="sr-only">{t("moreActions")}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isPasskey ? (
                <>
                  {username && (
                    <DropdownMenuItem onSelect={handleCopyUsername}>
                      <User className="h-4 w-4" />
                      {t("copyUsername")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={handleCopyCredentialId}>
                    <Copy className="h-4 w-4" />
                    {t("copyCredentialId")}
                  </DropdownMenuItem>
                </>
              ) : isIdentity ? (
                <DropdownMenuItem onSelect={handleCopyIdNumber}>
                  <Copy className="h-4 w-4" />
                  {t("copyIdNumber")}
                </DropdownMenuItem>
              ) : isCreditCard ? (
                <>
                  <DropdownMenuItem onSelect={handleCopyCardNumber}>
                    <Copy className="h-4 w-4" />
                    {t("copyCardNumber")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleCopyCvv}>
                    <Copy className="h-4 w-4" />
                    {t("copyCvv")}
                  </DropdownMenuItem>
                </>
              ) : isNote ? (
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
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={async () => {
                  if (!isOrgMode) {
                    // Personal: decrypt entry data, strip TOTP
                    try {
                      const { entry } = await fetchDecryptedEntry();
                      const { totp: _t, passwordHistory: _ph, tags: _tags, ...safe } = entry;
                      setShareData(safe as Record<string, unknown>);
                    } catch {
                      toast.error(t("networkError"));
                      return;
                    }
                  }
                  setShareDialogOpen(true);
                }}
              >
                <LinkIcon className="h-4 w-4" />
                {t("share")}
              </DropdownMenuItem>
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
          </div>
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
              orgId={orgId}
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

      <ShareDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        passwordEntryId={isOrgMode ? undefined : id}
        orgPasswordEntryId={isOrgMode ? id : undefined}
        decryptedData={shareData}
      />

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
