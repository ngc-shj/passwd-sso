"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getTagColorClass } from "@/lib/dynamic-styles";

interface TagBadgeProps {
  name: string;
  color: string | null;
}

export function TagBadge({ name, color }: TagBadgeProps) {
  const colorClass = getTagColorClass(color);

  return (
    <Badge
      variant="outline"
      className={cn("text-xs", colorClass && "tag-color", colorClass)}
    >
      {name}
    </Badge>
  );
}
