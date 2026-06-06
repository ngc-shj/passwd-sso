"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { CopyButton } from "../shared/copy-button";
import {
  User,
  MoreVertical,
  Copy,
  ExternalLink,
  Edit,
  Archive,
  ArchiveRestore,
  Trash2,
  RotateCcw,
  Link as LinkIcon,
} from "lucide-react";
import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";

interface EntryActionsMenuProps {
  entryType: EntryTypeValue;
  username?: string | null;
  urlHost?: string | null;
  isArchived: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canShare: boolean;
  // Copy value fetchers (per entry type)
  fetchPassword: () => Promise<string>;
  fetchContent: () => Promise<string>;
  fetchCardField: (field: "cardNumber" | "cvv") => Promise<string>;
  fetchIdentityField: (field: "idNumber") => Promise<string>;
  fetchPasskeyField: (field: "credentialId" | "username") => Promise<string>;
  fetchBankField: (field: "accountNumber" | "routingNumber") => Promise<string>;
  fetchLicenseField: (field: "licenseKey") => Promise<string>;
  fetchSshField: (field: "fingerprint" | "publicKey") => Promise<string>;
  // Action handlers
  onCopyUsername: () => void;
  onCopyPassword: () => void;
  onCopyContent: () => void;
  onCopyCardNumber: () => void;
  onCopyCvv: () => void;
  onCopyCredentialId: () => void;
  onCopyAccountNumber: () => void;
  onCopyLicenseKey: () => void;
  onCopyFingerprint: () => void;
  onCopyPublicKey: () => void;
  onCopyIdNumber: () => void;
  onOpenUrl: () => void;
  onShare: () => void;
  onEdit: () => void;
  onToggleArchive: () => void;
  onDeleteRequest: () => void;
  // Trash-view affordances (C9 — gated by descriptor.rowActions + adapter.permissions.canDelete).
  // When absent (normal/archive views), these menu items do NOT render (INV-C9.3).
  onRestore?: () => void;
  onDeletePermanently?: () => void;
  /** Applied to the overflow (⋮) trigger wrapper only — lets the row hide it until hover. */
  overflowClassName?: string;
  /** tabIndex for the quick-copy + overflow buttons. On a 3-pane row they are mouse
   *  accelerators (tabIndex=-1); keyboard users use the detail-pane actions. */
  tabIndex?: number;
  // i18n strings
  t: (key: string) => string;
}

/**
 * The quick-copy button + overflow dropdown-menu cluster for a vault entry row.
 * Shared by PasswordCard (accordion) and PasswordRow (compact, C6) — do not duplicate this logic.
 */
export function EntryActionsMenu({
  entryType,
  username,
  urlHost,
  isArchived,
  canEdit,
  canDelete,
  canShare,
  fetchPassword,
  fetchContent,
  fetchCardField,
  fetchIdentityField,
  fetchPasskeyField,
  fetchBankField,
  fetchLicenseField,
  fetchSshField,
  onCopyUsername,
  onCopyPassword,
  onCopyContent,
  onCopyCardNumber,
  onCopyCvv,
  onCopyCredentialId,
  onCopyAccountNumber,
  onCopyLicenseKey,
  onCopyFingerprint,
  onCopyPublicKey,
  onCopyIdNumber,
  onOpenUrl,
  onShare,
  onEdit,
  onToggleArchive,
  onDeleteRequest,
  onRestore,
  onDeletePermanently,
  overflowClassName,
  tabIndex,
  t,
}: EntryActionsMenuProps) {
  const isNote = entryType === ENTRY_TYPE.SECURE_NOTE;
  const isCreditCard = entryType === ENTRY_TYPE.CREDIT_CARD;
  const isIdentity = entryType === ENTRY_TYPE.IDENTITY;
  const isPasskey = entryType === ENTRY_TYPE.PASSKEY;
  const isBankAccount = entryType === ENTRY_TYPE.BANK_ACCOUNT;
  const isSoftwareLicense = entryType === ENTRY_TYPE.SOFTWARE_LICENSE;
  const isSshKey = entryType === ENTRY_TYPE.SSH_KEY;

  return (
    <div className="flex items-center shrink-0 pointer-events-none">
      <div
        className="pointer-events-auto"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {!isNote && !isCreditCard && !isIdentity && !isPasskey && !isBankAccount && !isSoftwareLicense && !isSshKey && (
          <CopyButton tabIndex={tabIndex} getValue={fetchPassword} />
        )}
        {isCreditCard && <CopyButton tabIndex={tabIndex} getValue={() => fetchCardField("cardNumber")} />}
        {isIdentity && <CopyButton tabIndex={tabIndex} getValue={() => fetchIdentityField("idNumber")} />}
        {isPasskey && <CopyButton tabIndex={tabIndex} getValue={() => fetchPasskeyField("credentialId")} />}
        {isBankAccount && <CopyButton tabIndex={tabIndex} getValue={() => fetchBankField("accountNumber")} />}
        {isSoftwareLicense && <CopyButton tabIndex={tabIndex} getValue={() => fetchLicenseField("licenseKey")} />}
        {isSshKey && <CopyButton tabIndex={tabIndex} getValue={() => fetchSshField("fingerprint")} />}
      </div>
      <div
        className={["pointer-events-auto", overflowClassName].filter(Boolean).join(" ")}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" tabIndex={tabIndex}>
              <MoreVertical className="h-4 w-4" />
              <span className="sr-only">{t("moreActions")}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {isBankAccount ? (
              <DropdownMenuItem onSelect={onCopyAccountNumber}>
                <Copy className="h-4 w-4" />
                {t("copyAccountNumber")}
              </DropdownMenuItem>
            ) : isSoftwareLicense ? (
              <DropdownMenuItem onSelect={onCopyLicenseKey}>
                <Copy className="h-4 w-4" />
                {t("copyLicenseKey")}
              </DropdownMenuItem>
            ) : isPasskey ? (
              <>
                {username && (
                  <DropdownMenuItem onSelect={onCopyUsername}>
                    <User className="h-4 w-4" />
                    {t("copyUsername")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={onCopyCredentialId}>
                  <Copy className="h-4 w-4" />
                  {t("copyCredentialId")}
                </DropdownMenuItem>
              </>
            ) : isIdentity ? (
              <DropdownMenuItem onSelect={onCopyIdNumber}>
                <Copy className="h-4 w-4" />
                {t("copyIdNumber")}
              </DropdownMenuItem>
            ) : isCreditCard ? (
              <>
                <DropdownMenuItem onSelect={onCopyCardNumber}>
                  <Copy className="h-4 w-4" />
                  {t("copyCardNumber")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onCopyCvv}>
                  <Copy className="h-4 w-4" />
                  {t("copyCvv")}
                </DropdownMenuItem>
              </>
            ) : isSshKey ? (
              <>
                <DropdownMenuItem onSelect={onCopyFingerprint}>
                  <Copy className="h-4 w-4" />
                  {t("copyFingerprint")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onCopyPublicKey}>
                  <Copy className="h-4 w-4" />
                  {t("copyPublicKey")}
                </DropdownMenuItem>
              </>
            ) : isNote ? (
              <DropdownMenuItem onSelect={onCopyContent}>
                <Copy className="h-4 w-4" />
                {t("copyContent")}
              </DropdownMenuItem>
            ) : (
              <>
                {username && (
                  <DropdownMenuItem onSelect={onCopyUsername}>
                    <User className="h-4 w-4" />
                    {t("copyUsername")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={onCopyPassword}>
                  <Copy className="h-4 w-4" />
                  {t("copyPassword")}
                </DropdownMenuItem>
                {urlHost && (
                  <DropdownMenuItem onSelect={onOpenUrl}>
                    <ExternalLink className="h-4 w-4" />
                    {t("openUrl")}
                  </DropdownMenuItem>
                )}
              </>
            )}
            {canShare && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onShare}>
                  <LinkIcon className="h-4 w-4" />
                  {t("share")}
                </DropdownMenuItem>
              </>
            )}
            {canEdit && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onEdit}>
                  <Edit className="h-4 w-4" />
                  {t("edit")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onToggleArchive}>
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
                    onDeleteRequest();
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  {t("delete")}
                </DropdownMenuItem>
              </>
            )}
            {/* C9 — trash-view affordances (INV-C9.3: absent for normal/archive). */}
            {onRestore && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onRestore}>
                  <RotateCcw className="h-4 w-4" />
                  {t("restore")}
                </DropdownMenuItem>
              </>
            )}
            {onDeletePermanently && (
              <>
                {!onRestore && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={(e) => {
                    e.preventDefault();
                    onDeletePermanently();
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  {t("deletePermanently")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
