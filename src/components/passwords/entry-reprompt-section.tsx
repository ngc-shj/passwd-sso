"use client";

import { ShieldCheck } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { EntrySectionCard } from "@/components/passwords/entry-form-ui";

interface EntryRepromptSectionProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  title: string;
  description: string;
  sectionCardClass?: string;
  checkboxId?: string;
}

export function EntryRepromptSection({
  checked,
  onCheckedChange,
  title,
  description,
  sectionCardClass = "",
  checkboxId = "require-reprompt",
}: EntryRepromptSectionProps) {
  return (
    <EntrySectionCard className={sectionCardClass}>
      <label className="flex cursor-pointer items-center gap-3" htmlFor={checkboxId}>
        <Checkbox
          id={checkboxId}
          checked={checked}
          onCheckedChange={(value) => onCheckedChange(!!value)}
        />
        <div className="space-y-0.5">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <ShieldCheck className="h-3.5 w-3.5" />
            {title}
          </span>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </label>
    </EntrySectionCard>
  );
}
