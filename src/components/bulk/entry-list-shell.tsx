"use client";

import { Fragment, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { FloatingActionBar } from "@/components/bulk/floating-action-bar";
import { BulkActionConfirmDialog } from "@/components/bulk/bulk-action-confirm-dialog";

/** Selection state passed to renderEntry when checkboxPlacement is "custom" */
export interface EntrySelectionState {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  ariaLabel: string;
}

interface BaseProps<T extends { id: string; title: string }> {
  entries: T[];
  selectionMode: boolean;
  selectedIds: ReadonlySet<string>;
  atLimit: boolean;
  onToggleSelectOne: (id: string, checked: boolean) => void;
  selectEntryLabel: (title: string) => string;
  /** Buttons inside the FloatingActionBar */
  floatingActions: ReactNode;
  /** BulkActionConfirmDialog props */
  confirmDialog: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: string;
    cancelLabel: string;
    confirmLabel: string;
    processing: boolean;
    onConfirm: () => void;
  };
  /** Extra elements rendered after the confirm dialog (e.g. edit dialogs) */
  children?: ReactNode;
}

interface ExternalCheckboxProps<T extends { id: string; title: string }> extends BaseProps<T> {
  /** Shell wraps each entry with Checkbox outside (default, PasswordCard pattern) */
  checkboxPlacement?: "external";
  renderEntry: (entry: T) => ReactNode;
}

interface CustomCheckboxProps<T extends { id: string; title: string }> extends BaseProps<T> {
  /** Caller handles checkbox placement inside renderEntry (trash Card pattern) */
  checkboxPlacement: "custom";
  renderEntry: (entry: T, selection: EntrySelectionState | null) => ReactNode;
}

type EntryListShellProps<T extends { id: string; title: string }> =
  | ExternalCheckboxProps<T>
  | CustomCheckboxProps<T>;

export function EntryListShell<T extends { id: string; title: string }>(
  props: EntryListShellProps<T>,
) {
  const {
    entries,
    selectionMode,
    selectedIds,
    atLimit,
    onToggleSelectOne,
    selectEntryLabel,
    renderEntry,
    floatingActions,
    confirmDialog,
    children,
  } = props;

  const isCustom = props.checkboxPlacement === "custom";

  return (
    <div className={selectionMode ? "space-y-2" : "space-y-1"}>
      {entries.map((entry) => {
        const selectionState: EntrySelectionState | null = selectionMode
          ? {
              checked: selectedIds.has(entry.id),
              disabled: atLimit && !selectedIds.has(entry.id),
              onCheckedChange: (v: boolean) => onToggleSelectOne(entry.id, v),
              ariaLabel: selectEntryLabel(entry.title),
            }
          : null;

        if (isCustom) {
          return (
            <Fragment key={entry.id}>
              {(renderEntry as CustomCheckboxProps<T>["renderEntry"])(entry, selectionState)}
            </Fragment>
          );
        }

        // External checkbox mode
        return selectionState ? (
          <div key={entry.id} className="flex items-start gap-2">
            <Checkbox
              className="mt-4"
              checked={selectionState.checked}
              disabled={selectionState.disabled}
              onCheckedChange={(v) => selectionState.onCheckedChange(Boolean(v))}
              aria-label={selectionState.ariaLabel}
            />
            <div className="flex-1 min-w-0">
              {(renderEntry as ExternalCheckboxProps<T>["renderEntry"])(entry)}
            </div>
          </div>
        ) : (
          <Fragment key={entry.id}>
            {(renderEntry as ExternalCheckboxProps<T>["renderEntry"])(entry)}
          </Fragment>
        );
      })}

      <FloatingActionBar visible={selectionMode && selectedIds.size > 0}>
        {floatingActions}
      </FloatingActionBar>

      <BulkActionConfirmDialog {...confirmDialog} />

      {children}
    </div>
  );
}
