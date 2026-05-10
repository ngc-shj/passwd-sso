"use client";

import { Globe, Users } from "lucide-react";

interface TeamScopeOptionProps {
  name: string;
  tenantName?: string;
  isCrossTenant?: boolean;
}

export function TeamScopeOption({
  name,
  tenantName,
  isCrossTenant = false,
}: TeamScopeOptionProps) {
  return (
    <div className="flex items-start gap-2">
      {isCrossTenant ? (
        <Globe className="h-4 w-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
      ) : (
        <Users className="h-4 w-4 mt-0.5 shrink-0" />
      )}
      <span className="flex flex-col items-start">
        <span>{name}</span>
        {isCrossTenant && tenantName && (
          <span className="text-xs text-amber-600 dark:text-amber-400">{tenantName}</span>
        )}
      </span>
    </div>
  );
}
