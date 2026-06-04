"use client";

import { useTranslations } from "next-intl";
import { Loader2, MousePointerClick } from "lucide-react";
import { PasswordDetailInline } from "./password-detail-inline";
import type { InlineDetailData } from "@/types/entry";

interface PasswordDetailPaneProps {
  entryId: string | null;
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

/**
 * Presentational pane for the master-detail layout (C2).
 *
 * States:
 *   - entryId === null → empty-state (INV-C2.2)
 *   - loading          → spinner skeleton
 *   - error            → generic error message (no raw error text exposed to UI)
 *   - detailData       → PasswordDetailInline body
 *
 * The parent MUST render this component with key={entryId} so that
 * reprompt/reveal timer state inside PasswordDetailInline resets on each
 * selection (INV-C2.1). The key is the sole defense against cross-entry
 * reveal carry-over (S5).
 */
export function PasswordDetailPane({
  entryId,
  detailData,
  loading,
  error,
  onEdit,
  onRefresh,
  teamId,
  readOnly,
}: PasswordDetailPaneProps) {
  const t = useTranslations("PasswordList");

  // INV-C2.2: entryId === null → empty-state; never show stale previous data.
  if (entryId === null) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-16 text-center text-muted-foreground gap-3">
        <MousePointerClick className="h-8 w-8 opacity-40" />
        <p className="text-sm">{t("selectAnEntry")}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full py-16 text-muted-foreground">
        <p className="text-sm" data-testid="detail-pane-error">
          {t("loadError")}
        </p>
      </div>
    );
  }

  if (!detailData) {
    return null;
  }

  return (
    <PasswordDetailInline
      data={detailData}
      onEdit={onEdit}
      onRefresh={onRefresh}
      teamId={teamId}
      readOnly={readOnly}
    />
  );
}
