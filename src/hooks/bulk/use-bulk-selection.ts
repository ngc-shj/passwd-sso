"use client";

import { useState, useMemo, useEffect, useCallback, useImperativeHandle } from "react";
import type { Ref } from "react";
import {
  MAX_BULK_SELECTION,
  reconcileSelectedIds,
  toggleSelectAllIds,
  toggleSelectOneId,
} from "@/lib/bulk-selection-helpers";

export interface BulkSelectionHandle {
  toggleSelectAll: (checked: boolean) => void;
}

export interface UseBulkSelectionOptions {
  /** Filtered/sorted entry IDs currently visible in the list */
  entryIds: readonly string[];
  /** Whether selection mode is active */
  selectionMode: boolean;
  /** Optional ref for parent to call toggleSelectAll imperatively */
  selectAllRef?: Ref<BulkSelectionHandle>;
  /** Maximum number of items that can be selected (defaults to MAX_BULK_SELECTION) */
  maxSelection?: number;
  /** Notify parent of selection count changes */
  onSelectedCountChange?: (count: number, allSelected: boolean, atLimit: boolean) => void;
}

export interface UseBulkSelectionReturn {
  selectedIds: Set<string>;
  allSelected: boolean;
  atLimit: boolean;
  toggleSelectOne: (id: string, checked: boolean) => void;
  toggleSelectAll: (checked: boolean) => void;
  clearSelection: () => void;
}

export function useBulkSelection({
  entryIds,
  selectionMode,
  selectAllRef,
  maxSelection = MAX_BULK_SELECTION,
  onSelectedCountChange,
}: UseBulkSelectionOptions): UseBulkSelectionReturn {
  const [rawSelectedIds, setRawSelectedIds] = useState<Set<string>>(new Set());

  // Clear selection when leaving selection mode (adjust state during render)
  const [prevSelectionMode, setPrevSelectionMode] = useState(selectionMode);
  if (selectionMode !== prevSelectionMode) {
    setPrevSelectionMode(selectionMode);
    if (!selectionMode) {
      setRawSelectedIds(new Set());
    }
  }

  // Derive reconciled selection: drop IDs not in current entryIds
  const selectedIds = useMemo(
    () => reconcileSelectedIds(rawSelectedIds, entryIds),
    [rawSelectedIds, entryIds],
  );

  const selectableCount = Math.min(entryIds.length, maxSelection);
  const allSelected =
    selectableCount > 0 && selectedIds.size === selectableCount;
  const atLimit = selectedIds.size >= maxSelection;

  // Notify parent of count / allSelected changes
  useEffect(() => {
    onSelectedCountChange?.(selectedIds.size, allSelected, atLimit);
  }, [selectedIds.size, allSelected, atLimit, onSelectedCountChange]);

  const toggleSelectOne = useCallback(
    (id: string, checked: boolean) => {
      setRawSelectedIds((prev) => toggleSelectOneId(prev, id, checked, maxSelection));
    },
    [maxSelection],
  );

  const toggleSelectAll = useCallback(
    (checked: boolean) => {
      setRawSelectedIds(toggleSelectAllIds(entryIds, checked, maxSelection));
    },
    [entryIds, maxSelection],
  );

  const clearSelection = useCallback(() => {
    setRawSelectedIds(new Set());
  }, []);

  // Expose toggleSelectAll to parent via imperative handle
  useImperativeHandle(
    selectAllRef,
    () => ({ toggleSelectAll }),
    [toggleSelectAll],
  );

  return {
    selectedIds,
    allSelected,
    atLimit,
    toggleSelectOne,
    toggleSelectAll,
    clearSelection,
  };
}
