import { BadgeCheck } from "lucide-react";

interface FormDirtyBadgeProps {
  hasChanges: boolean;
  unsavedLabel: string;
  savedLabel: string;
}

export function FormDirtyBadge({
  hasChanges,
  unsavedLabel,
  savedLabel,
}: FormDirtyBadgeProps) {
  return (
    <div
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] ${
        hasChanges
          ? "bg-amber-100 text-amber-800"
          : "bg-emerald-100 text-emerald-800"
      }`}
    >
      <BadgeCheck className="h-3.5 w-3.5" />
      {hasChanges ? unsavedLabel : savedLabel}
    </div>
  );
}
