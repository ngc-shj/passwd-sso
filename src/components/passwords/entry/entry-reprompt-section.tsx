"use client";

import { ShieldCheck } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { EntrySectionCard } from "@/components/passwords/entry/entry-form-ui";

interface EntryRepromptSectionProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  title: string;
  description: string;
  sectionCardClass?: string;
  checkboxId?: string;
  policyForced?: boolean;
  policyForcedLabel?: string;
}

export function EntryRepromptSection({
  checked,
  onCheckedChange,
  title,
  description,
  sectionCardClass = "",
  checkboxId = "require-reprompt",
  policyForced,
  policyForcedLabel,
}: EntryRepromptSectionProps) {
  const isChecked = policyForced || checked;
  return (
    <EntrySectionCard className={sectionCardClass}>
      <label className="flex cursor-pointer items-center gap-3" htmlFor={checkboxId}>
        <Checkbox
          id={checkboxId}
          checked={isChecked}
          disabled={policyForced}
          onCheckedChange={(value) => onCheckedChange(!!value)}
        />
        <div className="space-y-0.5">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <ShieldCheck className="h-3.5 w-3.5" />
            {title}
          </span>
          <p className="text-xs text-muted-foreground">{description}</p>
          {policyForced && policyForcedLabel && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{policyForcedLabel}</p>
          )}
        </div>
      </label>
    </EntrySectionCard>
  );
}
