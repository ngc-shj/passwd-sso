"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { apiPath } from "@/lib/constants/api-path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BulkActionType = "trash" | "archive" | "unarchive" | "restore";

export type BulkScope =
  | { type: "personal" }
  | { type: "team"; teamId: string };

export interface UseBulkActionOptions {
  selectedIds: Set<string>;
  scope: BulkScope;
  /** Method syntax for bivariant compatibility with next-intl Translator */
  t(key: string, params?: Record<string, unknown>): string;
  /**
   * Called after a successful bulk action.
   * The caller is responsible for:
   * - Clearing selection (`clearSelection()`)
   * - Refreshing the entry list (`fetchPasswords()`, etc.)
   * - Notifying parent of data changes (`onDataChange?.()`)
   */
  onSuccess: () => void;
}

export interface UseBulkActionReturn {
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  pendingAction: BulkActionType | null;
  processing: boolean;
  /** Open the confirmation dialog for a specific action */
  requestAction: (action: BulkActionType) => void;
  /** Execute the pending action — call from dialog confirm button */
  executeAction: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveEndpoint(scope: BulkScope, action: BulkActionType): string {
  if (scope.type === "team") {
    const { teamId } = scope;
    switch (action) {
      case "trash":
        return apiPath.teamPasswordsBulkTrash(teamId);
      case "archive":
      case "unarchive":
        return apiPath.teamPasswordsBulkArchive(teamId);
      case "restore":
        return apiPath.teamPasswordsBulkRestore(teamId);
    }
  }
  switch (action) {
    case "trash":
      return apiPath.passwordsBulkTrash();
    case "archive":
    case "unarchive":
      return apiPath.passwordsBulkArchive();
    case "restore":
      return apiPath.passwordsBulkRestore();
  }
}

function buildBody(
  action: BulkActionType,
  ids: string[],
): Record<string, unknown> {
  if (action === "archive" || action === "unarchive") {
    return { ids, operation: action };
  }
  return { ids };
}

function extractCount(
  json: Record<string, unknown>,
  fallback: number,
): number {
  return (json.processedCount ??
    json.archivedCount ??
    json.unarchivedCount ??
    json.movedCount ??
    json.restoredCount ??
    fallback) as number;
}

const TOAST_KEYS: Record<BulkActionType, { success: string; error: string }> = {
  archive: { success: "bulkArchived", error: "bulkArchiveFailed" },
  unarchive: { success: "bulkUnarchived", error: "bulkUnarchiveFailed" },
  trash: { success: "bulkMovedToTrash", error: "bulkMoveFailed" },
  restore: { success: "bulkRestored", error: "bulkRestoreFailed" },
};

// Exported for testing
export { resolveEndpoint, buildBody, extractCount, TOAST_KEYS };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useBulkAction({
  selectedIds,
  scope,
  t,
  onSuccess,
}: UseBulkActionOptions): UseBulkActionReturn {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<BulkActionType | null>(
    null,
  );
  const [processing, setProcessing] = useState(false);

  const requestAction = useCallback((action: BulkActionType) => {
    setPendingAction(action);
    setDialogOpen(true);
  }, []);

  const executeAction = useCallback(async () => {
    if (selectedIds.size === 0 || !pendingAction) return;
    if (scope.type === "team" && !scope.teamId) return;

    setProcessing(true);
    try {
      const ids = Array.from(selectedIds);
      const endpoint = resolveEndpoint(scope, pendingAction);
      const body = buildBody(pendingAction, ids);

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error("bulk action failed");

      const json = await res.json();
      const count = extractCount(json, ids.length);
      const keys = TOAST_KEYS[pendingAction];
      toast.success(t(keys.success, { count }));

      setDialogOpen(false);
      onSuccess();
    } catch {
      const keys = TOAST_KEYS[pendingAction];
      toast.error(t(keys.error));
    } finally {
      setProcessing(false);
    }
  }, [selectedIds, pendingAction, scope, t, onSuccess]);

  return {
    dialogOpen,
    setDialogOpen,
    pendingAction,
    processing,
    requestAction,
    executeAction,
  };
}
