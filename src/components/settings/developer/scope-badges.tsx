"use client";

import { useState } from "react";
import { ChevronUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const SCOPE_DISPLAY_LIMIT = 3;

function scopeVariant(scope: string): "outline" | "default" | "secondary" | "destructive" {
  const s = scope.toLowerCase();
  if (s.includes("write") || s.includes("delete")) return "destructive";
  if (s.includes("create") || s.includes("use") || s.includes("unlock")) return "default";
  // read, list, status, etc.
  return "secondary";
}

export function ScopeBadges({
  scopes,
  separator = ",",
}: {
  scopes: string;
  separator?: string | RegExp;
}) {
  const [expanded, setExpanded] = useState(false);
  const all = scopes.split(separator).map((s) => s.trim()).filter(Boolean);
  const visible = expanded ? all : all.slice(0, SCOPE_DISPLAY_LIMIT);
  const hidden = all.length - SCOPE_DISPLAY_LIMIT;

  if (all.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((scope) => (
        <Badge key={scope} variant={scopeVariant(scope)} className="text-xs font-normal">
          {scope}
        </Badge>
      ))}
      {hidden > 0 && !expanded && (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded(true)}
        >
          +{hidden}
        </button>
      )}
      {expanded && hidden > 0 && (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded(false)}
        >
          <ChevronUp className="h-3 w-3 inline" />
        </button>
      )}
    </div>
  );
}
