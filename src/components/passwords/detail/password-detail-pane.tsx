"use client";

import { useTranslations } from "next-intl";
import {
  Loader2,
  MousePointerClick,
  MoreVertical,
  Star,
  Archive,
  ArchiveRestore,
  Trash2,
  RotateCcw,
  Link as LinkIcon,
} from "lucide-react";
import { PasswordDetailInline } from "./password-detail-inline";
import { EntryIcon } from "./entry-icon";
import { CopyButton } from "../shared/copy-button";
import { TagBadge } from "@/components/tags/tag-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import type { InlineDetailData } from "@/types/entry";

/**
 * Minimal entry shape required by PasswordDetailPane.
 * Both DisplayEntry (personal vault) and TeamPasswordEntry (team vault) satisfy
 * this interface, keeping PasswordDetailPane vault-agnostic (Commonization principle).
 */
export interface PasswordDetailPaneEntry {
  entryType: EntryTypeValue;
  title: string;
  username: string | null;
  urlHost: string | null;
  tags: { name: string; color: string | null }[];
}

interface PasswordDetailPaneProps {
  entryId: string | null;
  /**
   * The overview row for the active entry (title, username, tags, …).
   * Rendered as the pane HEADER immediately — no decryption needed — so the
   * identity is visible while the encrypted body is still decrypting (the row
   * in the left pane is a separate component, so the right pane must carry its
   * own identity header).
   */
  entry: PasswordDetailPaneEntry | null;
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
  // Persistent action home (the experts' fix): Share/Archive/Delete (or Restore/
  // Delete-permanently in trash) + favorite live here, always reachable once an entry
  // is selected — so the list row's ⋮ is a pure mouse accelerator. Each renders only
  // when its handler is provided (gated by descriptor × permissions in EntryListView).
  showFavorite?: boolean;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  onShare?: () => void;
  isArchived?: boolean;
  onArchive?: () => void;
  onDelete?: () => void;
  onRestore?: () => void;
  onDeletePermanently?: () => void;
}

const MAX_VISIBLE_TAGS = 6;

/**
 * Presentational pane for the master-detail layout (C2).
 *
 * Structure:
 *   - header  → entry identity (icon + title) + the username as a labeled,
 *               copyable field (the username has no field in the body — it was
 *               historically rendered by the card row), + tags. Rendered
 *               instantly from the overview row (no decrypt).
 *   - body    → the decrypted detail (PasswordDetailInline: password / URL /
 *               notes / history / attachments / edit), or a loading/error state.
 *
 * The URL is intentionally NOT shown in the header — it already appears in the
 * list row and in the detail body (redundant noise).
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
  showFavorite,
  isFavorite,
  onToggleFavorite,
  onShare,
  isArchived,
  onArchive,
  onDelete,
  onRestore,
  onDeletePermanently,
}: PasswordDetailPaneProps) {
  const t = useTranslations("PasswordList");
  const td = useTranslations("PasswordDetail");
  const tc = useTranslations("PasswordCard");
  const tTrash = useTranslations("Trash");

  const hasMenuActions = !!(onShare || onArchive || onDelete || onRestore || onDeletePermanently);

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
        <div className="space-y-3 border-b px-4 py-3">
          {/* icon + title */}
          <div className="flex items-center gap-3">
            <EntryIcon
              entryType={entry.entryType ?? ENTRY_TYPE.LOGIN}
              urlHost={entry.urlHost}
              size={28}
              className="shrink-0 text-muted-foreground"
            />
            <h2 className="min-w-0 flex-1 truncate text-lg font-semibold" data-testid="detail-pane-title">
              {entry.title}
            </h2>

            {/* Persistent action home — always reachable once an entry is selected. */}
            <div className="flex shrink-0 items-center gap-1">
              {showFavorite && onToggleFavorite && (
                <button
                  type="button"
                  onClick={onToggleFavorite}
                  className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={isFavorite ? tc("unfavorite") : tc("favorite")}
                  aria-pressed={isFavorite}
                >
                  <Star className={isFavorite ? "h-4 w-4 fill-yellow-400 text-yellow-400" : "h-4 w-4"} />
                </button>
              )}
              {hasMenuActions && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <MoreVertical className="h-4 w-4" />
                      <span className="sr-only">{tc("moreActions")}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {onShare && (
                      <DropdownMenuItem onSelect={onShare}>
                        <LinkIcon className="h-4 w-4" />
                        {tc("share")}
                      </DropdownMenuItem>
                    )}
                    {onArchive && (
                      <DropdownMenuItem onSelect={onArchive}>
                        {isArchived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                        {isArchived ? tc("unarchive") : tc("archive")}
                      </DropdownMenuItem>
                    )}
                    {onRestore && (
                      <DropdownMenuItem onSelect={onRestore}>
                        <RotateCcw className="h-4 w-4" />
                        {tTrash("restore")}
                      </DropdownMenuItem>
                    )}
                    {onDelete && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={(e) => { e.preventDefault(); onDelete(); }}
                        >
                          <Trash2 className="h-4 w-4" />
                          {tc("delete")}
                        </DropdownMenuItem>
                      </>
                    )}
                    {onDeletePermanently && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={(e) => { e.preventDefault(); onDeletePermanently(); }}
                        >
                          <Trash2 className="h-4 w-4" />
                          {tTrash("deletePermanently")}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>

          {/* Username as a labeled, copyable field (same layout as the body fields).
              The username has no field in PasswordDetailInline — it lived in the card
              row — so the pane surfaces it here. Plaintext from the overview row, so
              no decryption is needed to copy it. */}
          {entry.username && (
            <div className="space-y-1" data-testid="detail-pane-username">
              <label className="text-sm text-muted-foreground">{td("username")}</label>
              <div className="flex items-center gap-2">
                <span className="break-all text-sm">{entry.username}</span>
                <CopyButton getValue={() => entry.username ?? ""} />
              </div>
            </div>
          )}

          {/* tags */}
          {visibleTags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {visibleTags.map((tag) => (
                <TagBadge key={tag.name} name={tag.name} color={tag.color} />
              ))}
              {overflowCount > 0 && (
                <span className="text-xs text-muted-foreground">+{overflowCount}</span>
              )}
            </div>
          )}
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
