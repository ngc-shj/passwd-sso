"use client";

import { useState } from "react";

import { useTranslations } from "next-intl";
import { useReprompt } from "@/hooks/vault/use-reprompt";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TagBadge } from "@/components/tags/tag-badge";
import { Favicon } from "../shared/favicon";
import {
  PasswordDetailInline,
  type InlineDetailData,
} from "./password-detail-inline";
import { PasswordEditDialogLoader } from "../dialogs/personal-password-edit-dialog-loader";
import {
  Star,
  ChevronRight,
  ChevronDown,
  Loader2,
  FileText,
  CreditCard,
  IdCard,
  Fingerprint,
  ShieldCheck,
  CalendarClock,
  Landmark,
  KeySquare,
} from "lucide-react";
import { toast } from "sonner";
import { copySecretToClipboard } from "@/lib/clipboard/copy-secret";
import { reportCopyOutcome } from "@/lib/clipboard/report-copy-outcome";
import { useVault } from "@/lib/vault/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto/crypto-client";
import { buildPersonalEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import { ShareDialog } from "@/components/share/share-dialog";
import { ENTRY_TYPE, apiPath } from "@/lib/constants";
import { MS_PER_DAY } from "@/lib/constants/time";
import { EXPIRING_THRESHOLD_DAYS } from "@/hooks/use-watchtower";
import type {
  EntryCustomField,
  EntryPasswordHistory,
  EntryTagNameColor,
  EntryTotp,
} from "@/lib/vault/entry-form-types";
import { fetchApi } from "@/lib/url-helpers";
import type { EntryCardData } from "@/types/entry-card";
import { usePasswordEntryDetail } from "@/hooks/vault/use-password-entry-detail";
import { buildPersonalGetDetail } from "@/lib/vault/build-personal-get-detail";
import { EntrySecondaryLine } from "./entry-secondary-line";
import { EntryActionsMenu } from "./entry-actions-menu";

export type { EntryCardData };

interface PasswordCardProps {
  entry: EntryCardData;
  expanded: boolean;
  onToggleFavorite: (id: string, current: boolean) => void;
  onToggleArchive: (id: string, current: boolean) => void;
  onDelete: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onRefresh: () => void;
  // C9 trash affordances — parity with PasswordRow. Absent (undefined) outside the
  // trash view, so the restore / permanent-delete menu items do not render there.
  onRestore?: (id: string) => void;
  onDeletePermanently?: (id: string) => void;
  // Optional: data providers for team mode (skip E2E decryption)
  getPassword?: () => Promise<string>;
  getDetail?: () => Promise<InlineDetailData>;
  getUrl?: () => Promise<string | null>;
  // Optional: custom edit handler (e.g. team edit dialog)
  onEditClick?: () => void;
  // Optional: RBAC permission control
  canEdit?: boolean;
  canDelete?: boolean;
  canShare?: boolean;
  /** When true, skip remote fetches in detail view (history, attachments) */
  readOnly?: boolean;
  // Optional: additional info display
  createdBy?: string | null;
  // Optional: team context
  teamId?: string;
}

interface VaultEntryFull {
  title: string;
  username?: string | null;
  password?: string;
  url?: string | null;
  notes?: string | null;
  content?: string;
  isMarkdown?: boolean;
  tags: EntryTagNameColor[];
  customFields?: EntryCustomField[];
  passwordHistory?: EntryPasswordHistory[];
  totp?: EntryTotp;
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
  bankName?: string | null;
  accountType?: string | null;
  accountHolderName?: string | null;
  accountNumber?: string | null;
  routingNumber?: string | null;
  swiftBic?: string | null;
  iban?: string | null;
  branchName?: string | null;
  softwareName?: string | null;
  licenseKey?: string | null;
  version?: string | null;
  licensee?: string | null;
  purchaseDate?: string | null;
  expirationDate?: string | null;
  privateKey?: string | null;
  publicKey?: string | null;
  keyType?: string | null;
  keySize?: number | null;
  fingerprint?: string | null;
  passphrase?: string | null;
  comment?: string | null;
}

export function PasswordCard({
  entry,
  expanded,
  onToggleFavorite,
  onToggleArchive,
  onDelete,
  onToggleExpand,
  onRefresh,
  onRestore,
  onDeletePermanently,
  getPassword: getPasswordProp,
  getDetail: getDetailProp,
  getUrl: getUrlProp,
  onEditClick,
  canEdit = true,
  canDelete = true,
  canShare = true,
  readOnly = false,
  createdBy,
  teamId,
}: PasswordCardProps) {
  const {
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
    bankName,
    accountNumberLast4,
    softwareName,
    licensee,
    keyType,
    fingerprint,
    tags,
    isFavorite,
    isArchived,
    requireReprompt,
    expiresAt,
  } = entry;
  const { createGuardedGetter, repromptDialog } = useReprompt();

  /**
   * Wraps a value-producing getter in the master-passphrase gate.
   *
   * Applied to the FETCHERS, not only to the overflow-menu handlers: the
   * fetchers are handed to EntryActionsMenu, which uses them directly as
   * CopyButton's `getValue` for the card's quick-copy control. Guarding only the
   * handlers would leave that one button releasing a secret with no prompt.
   *
   * The flag comes from the overview row, which is always loaded; the decrypted
   * detail agrees but only exists once the card is expanded.
   */
  const guard = (getter: () => Promise<string> | string) => async () => {
    const value = await getter();
    return createGuardedGetter(id, detailData?.requireReprompt ?? requireReprompt, () => value)();
  };
  const scopedTeamId = teamId;
  const isTeamMode = !!getPasswordProp;
  const isNote = entryType === ENTRY_TYPE.SECURE_NOTE;
  const isCreditCard = entryType === ENTRY_TYPE.CREDIT_CARD;
  const isIdentity = entryType === ENTRY_TYPE.IDENTITY;
  const isPasskey = entryType === ENTRY_TYPE.PASSKEY;
  const isBankAccount = entryType === ENTRY_TYPE.BANK_ACCOUNT;
  const isSoftwareLicense = entryType === ENTRY_TYPE.SOFTWARE_LICENSE;
  const t = useTranslations("PasswordCard");
  const tDash = useTranslations("Dashboard");
  const tc = useTranslations("Common");
  const tCopy = useTranslations("CopyButton");
  const { encryptionKey, userId, status: vaultStatus } = useVault();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareData, setShareData] = useState<Record<string, unknown> | undefined>(undefined);
  // Wall-clock snapshot read once via a lazy initializer (reading Date.now()/new Date()
  // directly in the render body is impure — flagged by the React Compiler rule). All
  // expiry math below uses the pure new Date(ms) form against this snapshot.
  const [nowMs] = useState(() => Date.now());
  const entryTypeLabel = {
    [ENTRY_TYPE.LOGIN]: tDash("catLogin"),
    [ENTRY_TYPE.SECURE_NOTE]: tDash("catSecureNote"),
    [ENTRY_TYPE.CREDIT_CARD]: tDash("catCreditCard"),
    [ENTRY_TYPE.IDENTITY]: tDash("catIdentity"),
    [ENTRY_TYPE.PASSKEY]: tDash("catPasskey"),
    [ENTRY_TYPE.BANK_ACCOUNT]: tDash("catBankAccount"),
    [ENTRY_TYPE.SOFTWARE_LICENSE]: tDash("catSoftwareLicense"),
    [ENTRY_TYPE.SSH_KEY]: tDash("catSshKey"),
  }[entryType] ?? entryType;

  // Low-level fetch+decrypt helper used by copy handlers and the personal getDetail closure.
  // NOT called directly by the expand lifecycle — the hook owns that.
  const fetchDecryptedEntry = async (): Promise<{ entry: VaultEntryFull; raw: Record<string, unknown> }> => {
    if (!encryptionKey) throw new Error("Vault locked");
    const res = await fetchApi(apiPath.passwordById(id));
    if (!res.ok) {
      throw new Error("Failed to fetch");
    }
    const raw = await res.json();
    const aad = raw.aadVersion >= 1 && userId
      ? buildPersonalEntryAAD(userId, id, VAULT_TYPE.BLOB)
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
    const { entry: e } = await fetchDecryptedEntry();
    return e.password ?? "";
  };

  const fetchContent = async (): Promise<string> => {
    const { entry: e } = await fetchDecryptedEntry();
    return e.content ?? "";
  };

  const fetchIdentityField = async (field: "idNumber"): Promise<string> => {
    if (getDetailProp) return (await getDetailProp())[field] ?? "";
    const { entry: e } = await fetchDecryptedEntry();
    return e[field] ?? "";
  };

  const fetchBankField = async (field: "accountNumber" | "routingNumber"): Promise<string> => {
    if (getDetailProp) return (await getDetailProp())[field] ?? "";
    const { entry: e } = await fetchDecryptedEntry();
    return e[field] ?? "";
  };

  const fetchLicenseField = async (field: "licenseKey"): Promise<string> => {
    if (getDetailProp) return (await getDetailProp())[field] ?? "";
    const { entry: e } = await fetchDecryptedEntry();
    return e[field] ?? "";
  };

  const fetchSshField = async (field: "fingerprint" | "publicKey"): Promise<string> => {
    if (getDetailProp) return (await getDetailProp())[field] ?? "";
    const { entry: e } = await fetchDecryptedEntry();
    return e[field] ?? "";
  };

  const fetchCardField = async (field: "cardNumber" | "cvv"): Promise<string> => {
    if (getDetailProp) return (await getDetailProp())[field] ?? "";
    const { entry: e } = await fetchDecryptedEntry();
    return e[field] ?? "";
  };

  const fetchPasskeyField = async (field: "credentialId" | "username"): Promise<string> => {
    if (getDetailProp) return (await getDetailProp())[field] ?? "";
    const { entry: e } = await fetchDecryptedEntry();
    return e[field] ?? "";
  };

  // Build the getDetail closure for usePasswordEntryDetail.
  // Team mode: delegate to the injected getDetailProp (already returns a complete InlineDetailData).
  // Personal mode: use the shared buildPersonalGetDetail helper — one source of truth for
  //   field assembly (INV-C1.7, Commonization principle). Both this accordion body and the
  //   personal master-detail pane consume the same shared builder.
  const getDetail = getDetailProp
    ? getDetailProp
    : encryptionKey
      ? buildPersonalGetDetail(
          { id, entryType, urlHost, requireReprompt },
          { encryptionKey, userId },
        )
      : async (): Promise<InlineDetailData> => {
          throw new Error("Vault locked");
        };

  // INV-C1.2: only decrypt when the card is expanded (entryId=null suppresses the fetch).
  // INV-C1.1/C1.3/C1.4 are enforced by the hook.
  const { detailData, loading: detailLoading, invalidate } = usePasswordEntryDetail(
    expanded ? id : null,
    { getDetail, vaultStatus }
  );

  // One reporter for all eleven handlers. They previously carried three
  // different behaviours for the same verb: nine reported a failure, one
  // (`handleCopyUsername`) swallowed it entirely, and eight returned silently on
  // an empty value — while content and password reported SUCCESS on an empty
  // value, having just wiped the clipboard with "". Only the last of those was
  // reachable from the UI for username (the menu item is gated on `username`);
  // for content and password it was plainly reachable, an empty secure note or
  // an entry saved with no password being enough.
  // The accordion card renders the same overflow menu as the 3-pane row but
  // supplies its own fetchers, so useEntryActions' gate never covered it — and
  // useLayoutMode returns "accordion" for every server and first-client render,
  // so this is not a narrow-viewport edge case.
  const runCopy = async (getter: () => Promise<string> | string) => {
    const guarded = async () => {
      const value = await getter();
      // The overview flag is authoritative and always present; the decrypted
      // detail agrees but is only loaded once the card is expanded.
      const flag = detailData?.requireReprompt ?? requireReprompt;
      return createGuardedGetter(id, flag, () => value)();
    };
    reportCopyOutcome(await copySecretToClipboard(guarded), { tCopy, tCard: t });
  };

  const handleCopyContent = () => runCopy(fetchContent);
  const handleCopyUsername = () => runCopy(() => username ?? "");
  const handleCopyPassword = () => runCopy(fetchPassword);
  const handleCopyCardNumber = () => runCopy(() => fetchCardField("cardNumber"));
  const handleCopyCvv = () => runCopy(() => fetchCardField("cvv"));
  const handleCopyCredentialId = () => runCopy(() => fetchPasskeyField("credentialId"));
  const handleCopyAccountNumber = () => runCopy(() => fetchBankField("accountNumber"));
  const handleCopyLicenseKey = () => runCopy(() => fetchLicenseField("licenseKey"));
  const handleCopyFingerprint = () => runCopy(() => fetchSshField("fingerprint"));
  const handleCopyPublicKey = () => runCopy(() => fetchSshField("publicKey"));
  const handleCopyIdNumber = () => runCopy(() => fetchIdentityField("idNumber"));

  const handleOpenUrl = async () => {
    try {
      if (getUrlProp) {
        const url = await getUrlProp();
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      } else {
        const { entry: e } = await fetchDecryptedEntry();
        if (e.url) window.open(e.url, "_blank", "noopener,noreferrer");
      }
    } catch {
      toast.error(t("networkError"));
    }
  };

  return (
    <>
      <Card
        className="py-0 gap-0 overflow-hidden border-l-2 border-l-transparent transition-colors hover:border-l-primary hover:bg-accent/30 dark:hover:bg-accent/50"
        onClick={() => onToggleExpand(id)}
      >
        <CardContent
          className="flex items-center gap-3 px-4 py-3"
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
          {isBankAccount ? (
            <Landmark className="h-5 w-5 shrink-0 text-muted-foreground" />
          ) : isSoftwareLicense ? (
            <KeySquare className="h-5 w-5 shrink-0 text-muted-foreground" />
          ) : isPasskey ? (
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
              {requireReprompt && (
                <ShieldCheck className="inline-block ml-1 h-3.5 w-3.5 text-muted-foreground align-text-bottom" />
              )}
              {(() => {
                if (!expiresAt) return null;
                const nowDate = new Date(nowMs);
                const todayStr = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, "0")}-${String(nowDate.getDate()).padStart(2, "0")}`;
                const thresholdDate = new Date(nowMs + EXPIRING_THRESHOLD_DAYS * MS_PER_DAY);
                const thresholdStr = `${thresholdDate.getFullYear()}-${String(thresholdDate.getMonth() + 1).padStart(2, "0")}-${String(thresholdDate.getDate()).padStart(2, "0")}`;
                const expiresDate = expiresAt.split("T")[0];
                if (expiresDate > thresholdStr) return null;
                const isExpired = expiresDate < todayStr;
                return (
                  <span title={isExpired ? t("expiredBadge") : t("expiringBadge")}>
                    <CalendarClock
                      className={`inline-block ml-1 h-3.5 w-3.5 align-text-bottom ${
                        isExpired ? "text-orange-500" : "text-amber-400"
                      }`}
                    />
                  </span>
                );
              })()}
            </span>
            <EntrySecondaryLine
              entryType={entryType}
              username={username}
              urlHost={urlHost}
              snippet={snippet}
              brand={brand}
              lastFour={lastFour}
              cardholderName={cardholderName}
              fullName={fullName}
              idNumberLast4={idNumberLast4}
              relyingPartyId={relyingPartyId}
              bankName={bankName}
              accountNumberLast4={accountNumberLast4}
              softwareName={softwareName}
              licensee={licensee}
              keyType={keyType}
              fingerprint={fingerprint}
              isTeamMode={isTeamMode}
              entryTypeLabel={entryTypeLabel}
            />
            {createdBy && (
              <span className="truncate text-xs text-muted-foreground block">
                {createdBy}
              </span>
            )}
          </div>
          {tags.length > 0 && (
            <div className="flex gap-1 shrink-0">
              {tags.map((tag) => (
                <TagBadge key={tag.name} name={tag.name} color={tag.color} />
              ))}
            </div>
          )}
          <EntryActionsMenu
            entryType={entryType}
            username={username}
            urlHost={urlHost}
            isArchived={isArchived}
            canEdit={canEdit}
            canDelete={canDelete}
            canShare={canShare}
            fetchPassword={guard(fetchPassword)}
            fetchCardField={(f) => guard(() => fetchCardField(f))()}
            fetchIdentityField={(f) => guard(() => fetchIdentityField(f))()}
            fetchPasskeyField={(f) => guard(() => fetchPasskeyField(f))()}
            fetchBankField={(f) => guard(() => fetchBankField(f))()}
            fetchLicenseField={(f) => guard(() => fetchLicenseField(f))()}
            fetchSshField={(f) => guard(() => fetchSshField(f))()}
            onCopyUsername={handleCopyUsername}
            onCopyPassword={handleCopyPassword}
            onCopyContent={handleCopyContent}
            onCopyCardNumber={handleCopyCardNumber}
            onCopyCvv={handleCopyCvv}
            onCopyCredentialId={handleCopyCredentialId}
            onCopyAccountNumber={handleCopyAccountNumber}
            onCopyLicenseKey={handleCopyLicenseKey}
            onCopyFingerprint={handleCopyFingerprint}
            onCopyPublicKey={handleCopyPublicKey}
            onCopyIdNumber={handleCopyIdNumber}
            onOpenUrl={handleOpenUrl}
            onShare={async () => {
              if (!isTeamMode) {
                // Personal: decrypt entry data, strip TOTP
                try {
                  const { entry: e } = await fetchDecryptedEntry();
                  const { totp: _t, passwordHistory: _ph, tags: _tags, ...safe } = e;
                  setShareData(safe as Record<string, unknown>);
                } catch {
                  toast.error(t("networkError"));
                  return;
                }
              } else if (getDetailProp) {
                // Team: decrypt via getDetail, strip TOTP/internal fields
                try {
                  const detail = await getDetailProp();
                  const { totp: _t, passwordHistory: _ph, id: _id, requireReprompt: _rp, ...safe } = detail;
                  setShareData(safe as Record<string, unknown>);
                } catch {
                  toast.error(t("networkError"));
                  return;
                }
              }
              setShareDialogOpen(true);
            }}
            onEdit={() => {
              if (onEditClick) onEditClick();
              else setEditDialogOpen(true);
            }}
            onToggleArchive={() => {
              onToggleArchive(id, isArchived);
              toast.success(isArchived ? t("unarchived") : t("archived"));
            }}
            onDeleteRequest={() => setDeleteDialogOpen(true)}
            onRestore={onRestore ? () => onRestore(id) : undefined}
            onDeletePermanently={
              onDeletePermanently ? () => onDeletePermanently(id) : undefined
            }
            t={t}
          />
        </CardContent>

        {/* Expanded inline detail */}
        {expanded && (
          detailLoading ? (
            <div
              className="flex items-center justify-center py-3 border-t"
              onClick={(e) => e.stopPropagation()}
            >
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : detailData ? (
            <div onClick={(e) => e.stopPropagation()}>
              <PasswordDetailInline
                data={detailData}
                onEdit={canEdit ? () => {
                  if (onEditClick) onEditClick();
                  else setEditDialogOpen(true);
                } : undefined}
                onRefresh={() => {
                  invalidate();
                  onRefresh();
                }}
                teamId={scopedTeamId}
                readOnly={readOnly}
              />
            </div>
          ) : null
        )}
      </Card>

      {!isTeamMode && (
        <PasswordEditDialogLoader
          id={id}
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          onSaved={() => {
            invalidate();
            onRefresh();
          }}
        />
      )}

      <ShareDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        passwordEntryId={isTeamMode ? undefined : id}
        teamPasswordEntryId={isTeamMode ? id : undefined}
        decryptedData={shareData}
        entryType={entryType}
        teamId={isTeamMode ? scopedTeamId : undefined}
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
      {/* Master-passphrase re-prompt for this card's copy actions. Scoped to the
          card because the accordion supplies its own fetchers and never goes
          through useEntryActions' instance. */}
      {repromptDialog}
    </>
  );
}
