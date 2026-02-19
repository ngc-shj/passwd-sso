"use client";

import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

interface PageTitleCardProps {
  icon: ReactNode;
  title: string;
  description?: string;
}

export function PageTitleCard({ icon, title, description }: PageTitleCardProps) {
  return (
    <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
      <div className="space-y-1.5">
        <h1 className="flex items-center gap-2 text-2xl font-bold leading-none tracking-tight">
          {icon}
          {title}
        </h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
    </Card>
  );
}
