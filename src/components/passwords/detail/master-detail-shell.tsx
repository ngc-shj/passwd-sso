"use client";

import type { ReactNode } from "react";

interface MasterDetailShellProps {
  /** The entry list panel (compact rows, search, etc.). */
  listSlot: ReactNode;
  /** The entry detail panel (PasswordDetailPane or similar). */
  detailSlot: ReactNode;
  /** Current layout mode — drives whether both panes or only the list is shown. */
  layoutMode: "master-detail" | "accordion";
  /** The id of the currently active entry (used for presence checks by parent; shell treats it as opaque). */
  activeEntryId: string | null;
}

/**
 * Vault-agnostic 3-pane layout shell (C5, INV-C5.6).
 *
 * master-detail mode (≥ lg breakpoint):
 *   Renders a flex row with two independent scroll containers (INV-C5.1):
 *   - list region: fixed-width (xl:w-[380px], min-w-[320px]), scrolls independently.
 *   - detail region: flex-1, scrolls independently.
 *   Full-bleed within the content area — max-w-4xl centering does NOT apply here (INV-C5.2).
 *
 * accordion mode (< lg breakpoint):
 *   Renders only listSlot full-width with the existing mx-auto max-w-4xl centering (INV-C5.2).
 *   detailSlot is not rendered (the detail is inline inside the list rows in accordion mode).
 *
 * This component is intentionally VAULT-AGNOSTIC: it accepts arbitrary ReactNode slots.
 * The personal dashboard and (later) the team page both mount the same shell (SC1 wiring task).
 * There is NO personal-specific branch inside this shell.
 */
export function MasterDetailShell({
  listSlot,
  detailSlot,
  layoutMode,
}: MasterDetailShellProps) {
  if (layoutMode === "accordion") {
    // Accordion mode: single-column with the existing centering (INV-C5.2).
    // detailSlot is not rendered — detail is inline inside the list rows.
    return (
      <div className="mx-auto max-w-4xl w-full">
        {listSlot}
      </div>
    );
  }

  // master-detail mode: separate overflow-auto scroll containers (INV-C5.1).
  // max-w-4xl is deliberately absent — full-bleed (INV-C5.2).
  return (
    <div className="flex h-full min-h-0 w-full">
      {/* List region — fixed width at xl, minimum 320px so compact rows stay legible */}
      <div
        className="xl:w-[380px] w-[320px] shrink-0 overflow-auto border-r"
        data-testid="master-detail-list"
      >
        {listSlot}
      </div>

      {/* Detail region — fills remaining width, independent scroll */}
      <div
        className="flex-1 overflow-auto"
        data-testid="master-detail-detail"
      >
        {detailSlot}
      </div>
    </div>
  );
}
