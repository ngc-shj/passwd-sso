"use client";

import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

interface EntryListHeaderProps {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  showSubtitle?: boolean;
  titleExtra?: ReactNode;
  actions?: ReactNode;
}

export function EntryListHeader({
  icon,
  title,
  subtitle,
  showSubtitle = false,
  titleExtra,
  actions,
}: EntryListHeaderProps) {
  return (
    <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 items-center gap-3">
            {icon}
            <h1 className="truncate text-2xl font-bold tracking-tight">{title}</h1>
            {titleExtra}
          </div>
          {showSubtitle && subtitle && (
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </Card>
  );
}
