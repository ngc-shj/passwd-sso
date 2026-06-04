"use client";

import { useTranslations } from "next-intl";
import { Loader2, MousePointerClick } from "lucide-react";
import { PasswordDetailInline } from "./password-detail-inline";
import { EntryIcon } from "./entry-icon";
import { EntrySecondaryLine } from "./entry-secondary-line";
import { EntryActionsMenu } from "./entry-actions-menu";
import { TagBadge } from "@/components/tags/tag-badge";
import { ENTRY_TYPE } from "@/lib/constants";
import type { InlineDetailData } from "@/types/entry";
import type { DisplayEntry } from "./password-list";
import type { EntryActionCallbacks } from "@/hooks/vault/use-entry-actions";

interface PasswordDetailPaneProps {
  entryId: string | null;
  /**
   * The overview row for the active entry (title, username, urlHost, tags, …).
   * Rendered as the pane HEADER immediately — no decryption needed — so the
   * identity is visible while the encrypted body is still decrypting (the row
   * in the left pane is a separate component, so the right pane must carry its
   * own identity header).
   */
  entry: DisplayEntry | null;
  detailData: InlineDetailData | null;
  loading: boolean;
  error: Error | null;
  // Action callbacks forwarded to PasswordDetailInline.
  // This pane is designed to be mounted with key={entryId} by its parent
  // (e.g. <PasswordDetailPane key={activeEntry?.id ?? "empty"} .../>).
  // That key boundary is the ENTIRE defense against cross-entry reveal
  // carry-over (INV-C2.1/S5): it tears down useReprompt and useRevealTimeout
  // inside PasswordDetailInline on every selection change. Do NOT hoist
  // useReprompt above this keyed boundary (INV-C2.3).
  onEdit?: () => void;
  onRefresh?: () => void;
  teamId?: string;
  readOnly?: boolean;
  // Header action menu — copy/fetch callbacks from useEntryActions (personal vault).
  // When present (entry + actions), EntryActionsMenu renders in the header title row.
  actions?: EntryActionCallbacks;
  onShare?: () => void;
  onToggleArchive?: () => void;
  onDeleteRequest?: () => void;
  canEdit?: boolean;
  canDelete?: boolean;
  canShare?: boolean;
}

const MAX_VISIBLE_TAGS = 6;

/**
 * Presentational pane for the master-detail layout (C2).
 *
 * Structure:
 *   - header  → entry identity (icon + title + secondary line + tags), rendered
 *               instantly from the overview row (no decrypt).
 *   - body    → the decrypted detail (PasswordDetailInline), or a loading/error state.
 *
 * States:
 *   - entryId === null → empty-state (INV-C2.2)
 *   - loading          → header + spinner skeleton
 *   - error            → header + generic error message (no raw error text)
 *   - detailData       → header + PasswordDetailInline body
 *
 * The parent MUST render this component with key={entryId} so that
 * reprompt/reveal timer state inside PasswordDetailInline resets on each
 * selection (INV-C2.1). The key is the sole defense against cross-entry
 * reveal carry-over (S5).
 */
export function PasswordDetailPane({
  entryId,
  entry,
  detailData,
  loading,
  error,
  onEdit,
  onRefresh,
  teamId,
  readOnly,
  actions,
  onShare,
  onToggleArchive,
  onDeleteRequest,
  canEdit,
  canDelete = false,
  canShare = false,
}: PasswordDetailPaneProps) {
  const t = useTranslations("PasswordList");
  const tCard = useTranslations("PasswordCard");

  // INV-C2.2: entryId === null → empty-state; never show stale previous data.
  if (entryId === null) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-16 text-center text-muted-foreground gap-3">
        <MousePointerClick className="h-8 w-8 opacity-40" />
        <p className="text-sm">{t("selectAnEntry")}</p>
      </div>
    );
  }

  const visibleTags = entry?.tags.slice(0, MAX_VISIBLE_TAGS) ?? [];
  const overflowCount = (entry?.tags.length ?? 0) - visibleTags.length;

  return (
    <div className="flex flex-col">
      {/* Identity header — rendered from the overview row, no decryption required. */}
      {entry && (
        <div className="flex items-start gap-3 border-b px-4 py-3">
          <EntryIcon
            entryType={entry.entryType ?? ENTRY_TYPE.LOGIN}
            urlHost={entry.urlHost}
            size={28}
            className="mt-0.5 shrink-0 text-muted-foreground"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <h2 className="truncate text-lg font-semibold flex-1" data-testid="detail-pane-title">
                {entry.title}
              </h2>
              {actions && (
                <EntryActionsMenu
                  entryType={entry.entryType ?? ENTRY_TYPE.LOGIN}
                  username={entry.username}
                  urlHost={entry.urlHost}
                  isArchived={entry.isArchived}
                  canEdit={canEdit ?? !entry.isArchived}
                  canDelete={canDelete}
                  canShare={canShare}
                  fetchPassword={actions.fetchPassword}
                  fetchContent={actions.fetchContent}
                  fetchCardField={actions.fetchCardField}
                  fetchIdentityField={actions.fetchIdentityField}
                  fetchPasskeyField={actions.fetchPasskeyField}
                  fetchBankField={actions.fetchBankField}
                  fetchLicenseField={actions.fetchLicenseField}
                  fetchSshField={actions.fetchSshField}
                  onCopyUsername={actions.onCopyUsername}
                  onCopyPassword={actions.onCopyPassword}
                  onCopyContent={actions.onCopyContent}
                  onCopyCardNumber={actions.onCopyCardNumber}
                  onCopyCvv={actions.onCopyCvv}
                  onCopyCredentialId={actions.onCopyCredentialId}
                  onCopyAccountNumber={actions.onCopyAccountNumber}
                  onCopyLicenseKey={actions.onCopyLicenseKey}
                  onCopyFingerprint={actions.onCopyFingerprint}
                  onCopyPublicKey={actions.onCopyPublicKey}
                  onCopyIdNumber={actions.onCopyIdNumber}
                  onOpenUrl={() => void actions.onOpenUrl()}
                  onShare={onShare ?? (() => {})}
                  onEdit={onEdit ?? (() => {})}
                  onToggleArchive={onToggleArchive ?? (() => {})}
                  onDeleteRequest={onDeleteRequest ?? (() => {})}
                  t={tCard}
                />
              )}
            </div>
            <div className="mt-0.5 text-sm text-muted-foreground" data-testid="detail-pane-secondary">
              <EntrySecondaryLine
                entryType={entry.entryType ?? ENTRY_TYPE.LOGIN}
                username={entry.username}
                urlHost={entry.urlHost}
                snippet={entry.snippet}
                brand={entry.brand}
                lastFour={entry.lastFour}
                cardholderName={entry.cardholderName}
                fullName={entry.fullName}
                idNumberLast4={entry.idNumberLast4}
                relyingPartyId={entry.relyingPartyId}
                bankName={entry.bankName}
                accountNumberLast4={entry.accountNumberLast4}
                softwareName={entry.softwareName}
                licensee={entry.licensee}
                keyType={entry.keyType}
                fingerprint={entry.fingerprint}
              />
            </div>
            {visibleTags.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {visibleTags.map((tag) => (
                  <TagBadge key={tag.name} name={tag.name} color={tag.color} />
                ))}
                {overflowCount > 0 && (
                  <span className="text-xs text-muted-foreground">+{overflowCount}</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Body — decrypted detail / loading / error. */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <p className="text-sm" data-testid="detail-pane-error">
            {t("loadError")}
          </p>
        </div>
      ) : detailData ? (
        <PasswordDetailInline
          data={detailData}
          onEdit={onEdit}
          onRefresh={onRefresh}
          teamId={teamId}
          readOnly={readOnly}
        />
      ) : null}
    </div>
  );
}
