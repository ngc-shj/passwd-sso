"use client";

import { useTranslations } from "next-intl";
import { Star } from "lucide-react";
import { TagBadge } from "@/components/tags/tag-badge";
import { EntryIcon } from "./entry-icon";
import { EntrySecondaryLine } from "./entry-secondary-line";
import { EntryActionsMenu } from "./entry-actions-menu";
import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";

// Maximum number of tags to show before adding an overflow indicator.
const MAX_VISIBLE_TAGS = 3;

/**
 * Minimal entry shape required by PasswordRow.
 * Both DisplayEntry (personal vault) and TeamPasswordEntry (team vault) satisfy
 * this interface, keeping PasswordRow vault-agnostic (Commonization principle).
 */
export interface PasswordRowEntry {
  id: string;
  entryType: EntryTypeValue;
  title: string;
  username: string | null;
  urlHost: string | null;
  snippet: string | null;
  brand: string | null;
  lastFour: string | null;
  cardholderName: string | null;
  fullName: string | null;
  idNumberLast4: string | null;
  relyingPartyId: string | null;
  bankName: string | null;
  accountNumberLast4: string | null;
  softwareName: string | null;
  licensee: string | null;
  keyType: string | null;
  fingerprint: string | null;
  tags: { name: string; color: string | null }[];
  isArchived: boolean;
  isFavorite: boolean;
}

interface PasswordRowProps {
  entry: PasswordRowEntry;
  /** Whether this row is the currently selected entry in the detail pane. */
  isActive: boolean;
  /** Called when the user clicks the row (selects this entry). */
  onActivate: () => void;

  // Selection-mode props (driven by EntryListShell external-checkbox pattern).
  // When selectionMode is true, the EntryListShell renders a checkbox before this
  // component inside a flex-1 min-w-0 wrapper; the row fills the remaining width and
  // its children truncate (INV-C6.3). The 320px legibility floor lives on the pane.
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (checked: boolean) => void;

  // Action callbacks for the overflow menu (EntryActionsMenu).
  // These fetch callbacks are provided by the parent — PasswordRow does NOT
  // own any decryption state (vault-agnostic, INV-C6.4).
  fetchPassword: () => Promise<string>;
  fetchContent: () => Promise<string>;
  fetchCardField: (field: "cardNumber" | "cvv") => Promise<string>;
  fetchIdentityField: (field: "idNumber") => Promise<string>;
  fetchPasskeyField: (field: "credentialId" | "username") => Promise<string>;
  fetchBankField: (field: "accountNumber" | "routingNumber") => Promise<string>;
  fetchLicenseField: (field: "licenseKey") => Promise<string>;
  fetchSshField: (field: "fingerprint" | "publicKey") => Promise<string>;
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
  // C9 — trash-view affordances (INV-C9.3: absent for normal/archive rows).
  onRestore?: () => void;
  onDeletePermanently?: () => void;

  // Favorite toggle — rendered only when showFavorite (gated by
  // descriptor.rowActions.favorite × adapter.supportsFavorite in the parent).
  showFavorite?: boolean;
  onToggleFavorite?: () => void;

  canEdit?: boolean;
  canDelete?: boolean;
  canShare?: boolean;
}

/**
 * Compact two-line row for master-detail mode (C6).
 *
 * Line 1: icon/favicon + title + quick-copy + overflow menu
 * Line 2: per-type secondary info (reuses EntrySecondaryLine — INV-C6.4) + tags
 *
 * The active row uses aria-current="true" for real a11y signalling (NOT only a
 * styling class — avoids the phantom-match trap, feedback_e2e_aria_label_phantom_match).
 *
 * Tags are on line 2 and may overflow — they are NOT shrink-0 crushing the title
 * (INV-C6.2). No chevron: selection replaces expand affordance (INV-C6.1).
 *
 * In selection mode, EntryListShell renders the external checkbox before this
 * component; the row fills the remaining pane width and its children truncate
 * (INV-C6.3 — the 320px legibility floor is enforced by the list pane, not the row).
 */
export function PasswordRow({
  entry,
  isActive,
  onActivate,
  selectionMode = false,
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
  showFavorite = false,
  onToggleFavorite,
  canEdit = true,
  canDelete = true,
  canShare = true,
}: PasswordRowProps) {
  const t = useTranslations("PasswordCard");

  const {
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
    isArchived,
    isFavorite,
  } = entry;

  const visibleTags = tags.slice(0, MAX_VISIBLE_TAGS);
  const overflowCount = tags.length - visibleTags.length;

  const handleClick = () => {
    // In selection mode, row click routes only to checkbox — onActivate is a no-op
    // (INV-C4.1: row click in selectionMode goes to bulk checkbox, not detail select).
    if (selectionMode) return;
    onActivate();
  };

  return (
    // aria-current="true" is the real a11y marker for the active row (NOT only a
    // styling class). This satisfies INV-C6 and avoids the phantom-match trap:
    // tests must query aria-current, not a class name.
    <div
      role="option"
      aria-current={isActive ? "true" : undefined}
      aria-selected={isActive}
      onClick={handleClick}
      className={[
        // No min-width here: the list pane (MasterDetailShell) enforces the 320px
        // floor. A row min-width would exceed the padded pane content and force a
        // horizontal scrollbar; instead the row fills the pane and its children truncate.
        "min-w-0 cursor-pointer select-none rounded-md px-3 py-2 transition-colors",
        "hover:bg-accent/40",
        isActive
          ? "bg-accent border-l-2 border-l-primary"
          : "border-l-2 border-l-transparent",
        selectionMode ? "cursor-default" : "cursor-pointer",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Line 1: icon + title + actions */}
      <div className="flex items-center gap-2">
        {/* Entry type icon / favicon — shared component (commonization, INV-C6.4) */}
        <div className="shrink-0 text-muted-foreground" data-testid="row-icon">
          <EntryIcon entryType={entryType} urlHost={urlHost} size={16} className="shrink-0" />
        </div>

        {/* Title — truncates when space is tight */}
        <span
          className="flex-1 min-w-0 truncate text-sm font-medium"
          data-testid="row-title"
        >
          {title}
        </span>

        {/* Favorite toggle — only when the view+vault support it (INV-C2.1). */}
        {showFavorite && onToggleFavorite && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite();
            }}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={isFavorite ? t("unfavorite") : t("favorite")}
            aria-pressed={isFavorite}
          >
            <Star
              className={isFavorite ? "h-4 w-4 fill-yellow-400 text-yellow-400" : "h-4 w-4"}
            />
          </button>
        )}

        {/* Quick-copy + overflow menu — stop propagation so they don't activate the row */}
        <EntryActionsMenu
          entryType={entryType}
          username={username}
          urlHost={urlHost}
          isArchived={isArchived}
          canEdit={canEdit}
          canDelete={canDelete}
          canShare={canShare}
          fetchPassword={fetchPassword}
          fetchContent={fetchContent}
          fetchCardField={fetchCardField}
          fetchIdentityField={fetchIdentityField}
          fetchPasskeyField={fetchPasskeyField}
          fetchBankField={fetchBankField}
          fetchLicenseField={fetchLicenseField}
          fetchSshField={fetchSshField}
          onCopyUsername={onCopyUsername}
          onCopyPassword={onCopyPassword}
          onCopyContent={onCopyContent}
          onCopyCardNumber={onCopyCardNumber}
          onCopyCvv={onCopyCvv}
          onCopyCredentialId={onCopyCredentialId}
          onCopyAccountNumber={onCopyAccountNumber}
          onCopyLicenseKey={onCopyLicenseKey}
          onCopyFingerprint={onCopyFingerprint}
          onCopyPublicKey={onCopyPublicKey}
          onCopyIdNumber={onCopyIdNumber}
          onOpenUrl={onOpenUrl}
          onShare={onShare}
          onEdit={onEdit}
          onToggleArchive={onToggleArchive}
          onDeleteRequest={onDeleteRequest}
          onRestore={onRestore}
          onDeletePermanently={onDeletePermanently}
          t={t}
        />
      </div>

      {/* Line 2: secondary info + tags (tags overflow, never crush the secondary line — INV-C6.2) */}
      <div className="flex items-center gap-2 mt-0.5 min-w-0">
        {/* Secondary line for per-type content — shared component, no re-implementation (INV-C6.4) */}
        <div className="flex-1 min-w-0" data-testid="row-secondary-line">
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
          />
        </div>

        {/* Tags — may overflow; NOT shrink-0 so they don't crush secondary content (INV-C6.2) */}
        {visibleTags.length > 0 && (
          <div className="flex gap-1 flex-wrap overflow-hidden max-w-[40%]">
            {visibleTags.map((tag) => (
              <TagBadge key={tag.name} name={tag.name} color={tag.color} />
            ))}
            {overflowCount > 0 && (
              <span className="text-xs text-muted-foreground">
                +{overflowCount}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
