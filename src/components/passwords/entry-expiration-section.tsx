"use client";

import { CalendarClock, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EntrySectionCard } from "@/components/passwords/entry-form-ui";

interface EntryExpirationSectionProps {
  value: string | null;
  onChange: (next: string | null) => void;
  title: string;
  description: string;
  sectionCardClass?: string;
}

export function EntryExpirationSection({
  value,
  onChange,
  title,
  description,
  sectionCardClass = "",
}: EntryExpirationSectionProps) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const dateValue = value ? value.slice(0, 10) : "";

  return (
    <EntrySectionCard className={sectionCardClass}>
      <div className="space-y-2">
        <div className="space-y-0.5">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <CalendarClock className="h-3.5 w-3.5" />
            {title}
          </span>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="date"
            value={dateValue}
            min={today}
            onChange={(e) => {
              const v = e.target.value;
              onChange(v ? `${v}T00:00:00.000Z` : null);
            }}
            className="w-auto"
          />
          {value && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onChange(null)}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </EntrySectionCard>
  );
}
