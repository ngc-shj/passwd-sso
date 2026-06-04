"use client";

import { useTranslations } from "next-intl";
import { Loader2, MousePointerClick } from "lucide-react";
import { PasswordDetailInline } from "./password-detail-inline";
import { EntryIcon } from "./entry-icon";
import { CopyButton } from "../shared/copy-button";
import { TagBadge } from "@/components/tags/tag-badge";
import { ENTRY_TYPE } from "@/lib/constants";
import type { InlineDetailData } from "@/types/entry";
import type { DisplayEntry } from "./password-list";

interface PasswordDetailPaneProps {
  entryId: string | null;
  /**
   * The overview row for the active entry (title, username, tags, …).
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
}: PasswordDetailPaneProps) {
  const t = useTranslations("PasswordList");
  const td = useTranslations("PasswordDetail");

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
