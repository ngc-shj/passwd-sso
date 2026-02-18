"use client";

import type { ReactNode } from "react";
import { Tags } from "lucide-react";
import { Label } from "@/components/ui/label";
import { EntrySectionCard } from "@/components/passwords/entry-form-ui";

interface EntryTagsSectionProps {
  title: string;
  hint: string;
  children: ReactNode;
}

export function EntryTagsSection({ title, hint, children }: EntryTagsSectionProps) {
  return (
    <EntrySectionCard>
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <Tags className="h-3.5 w-3.5" />
          {title}
        </Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </EntrySectionCard>
  );
}
