"use client";

import type { ReactNode } from "react";
import { BadgeCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export const ENTRY_DIALOG_FLAT_PRIMARY_CARD_CLASS =
  "!rounded-none !border-0 !bg-transparent !from-transparent !to-transparent !p-0 !shadow-none";

export const ENTRY_DIALOG_FLAT_SECTION_CLASS =
  "!rounded-none !border-0 !bg-transparent !px-1 !py-2 !shadow-none hover:!bg-transparent";

interface EntryCardProps {
  children: ReactNode;
  className?: string;
}

interface EntryActionBarProps {
  hasChanges: boolean;
  submitting: boolean;
  submitDisabled?: boolean;
  saveLabel: string;
  cancelLabel: string;
  statusUnsavedLabel: string;
  statusSavedLabel: string;
  onCancel: () => void;
  onSubmit?: () => void;
  submitType?: "button" | "submit";
}

export function EntryPrimaryCard({ children, className = "" }: EntryCardProps) {
  return (
    <div
      className={`rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4 space-y-4 transition-colors ${className}`.trim()}
    >
      {children}
    </div>
  );
}

export function EntrySectionCard({ children, className = "" }: EntryCardProps) {
  return (
    <div
      className={`space-y-2 rounded-xl border bg-muted/20 p-4 transition-colors hover:bg-accent ${className}`.trim()}
    >
      {children}
    </div>
  );
}

export function EntryActionBar({
  hasChanges,
  submitting,
  submitDisabled = false,
  saveLabel,
  cancelLabel,
  statusUnsavedLabel,
  statusSavedLabel,
  onCancel,
  onSubmit,
  submitType = "submit",
}: EntryActionBarProps) {
  return (
    <div className="sticky bottom-0 z-10 -mx-1 rounded-lg border bg-background/90 px-3 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="flex items-center justify-between gap-3">
        <div
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] ${
            hasChanges ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"
          }`}
        >
          <BadgeCheck className="h-3.5 w-3.5" />
          {hasChanges ? statusUnsavedLabel : statusSavedLabel}
        </div>
        <div className="flex gap-2">
          <Button
            type={submitType}
            onClick={onSubmit}
            disabled={submitting || submitDisabled}
          >
            {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {saveLabel}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
