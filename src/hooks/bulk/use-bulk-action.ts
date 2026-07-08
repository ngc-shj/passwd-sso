"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { apiPath } from "@/lib/constants/auth/api-path";
import { fetchApi } from "@/lib/url-helpers";
import { notifyTeamDataChanged } from "@/lib/events";
import { handleStepUpError } from "@/lib/http/handle-step-up-error";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BulkActionType = "trash" | "archive" | "unarchive" | "restore" | "deletePermanently";

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
   *
   * Note: For team scope, `team-data-changed` is dispatched automatically
   * after onSuccess — no manual dispatch needed.
   */
  onSuccess: () => void;
  /**
   * Called when the `deletePermanently` bulk action (bulk-purge) hits a
   * `SESSION_STEP_UP_REQUIRED` 403 — only this action is step-up-gated.
   * The caller opens its reauth dialog (typically
   * `inlineReauth.triggerOnStaleError`); the hook closes the confirm dialog
   * and does not surface a generic error toast for this case.
   */
  onStepUpRequired?: () => Promise<void> | void;
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
      case "deletePermanently":
        return apiPath.teamPasswordsBulkPurge(teamId);
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
    case "deletePermanently":
      return apiPath.passwordsBulkPurge();
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
    json.deletedCount ??
    fallback) as number;
}

const TOAST_KEYS: Record<BulkActionType, { success: string; error: string }> = {
  archive: { success: "bulkArchived", error: "bulkArchiveFailed" },
  unarchive: { success: "bulkUnarchived", error: "bulkUnarchiveFailed" },
  trash: { success: "bulkMovedToTrash", error: "bulkMoveFailed" },
  restore: { success: "bulkRestored", error: "bulkRestoreFailed" },
  deletePermanently: { success: "bulkDeleted", error: "bulkDeleteFailed" },
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
  onStepUpRequired,
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

      // @stepup id:passwords-bulk-purge
      // @stepup id:team-password-bulk-purge
      const res = await fetchApi(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // Only the permanent-purge action is step-up-gated. Route the 403 to
        // reauth ONLY when a handler is wired; otherwise fall through to the
        // generic error toast rather than silently closing the dialog — an
        // omitted onStepUpRequired must not swallow the mutation.
        if (pendingAction === "deletePermanently" && onStepUpRequired) {
          const reauth = onStepUpRequired;
          if (await handleStepUpError(res, async () => { await reauth(); })) {
            setDialogOpen(false);
            return;
          }
        }
        throw new Error("bulk action failed");
      }

      const json = await res.json();
      const count = extractCount(json, ids.length);
      const keys = TOAST_KEYS[pendingAction];
      toast.success(t(keys.success, { count }));

      setDialogOpen(false);
      onSuccess();
      if (scope.type === "team") notifyTeamDataChanged();
    } catch {
      const keys = TOAST_KEYS[pendingAction];
      toast.error(t(keys.error));
    } finally {
      setProcessing(false);
    }
  }, [selectedIds, pendingAction, scope, t, onSuccess, onStepUpRequired]);

  return {
    dialogOpen,
    setDialogOpen,
    pendingAction,
    processing,
    requestAction,
    executeAction,
  };
}
