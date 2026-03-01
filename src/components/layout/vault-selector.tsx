"use client";

import { Building2, Globe, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface VaultSelectorTeam {
  id: string;
  name: string;
  tenantName?: string;
  isCrossTenant?: boolean;
}

interface VaultSelectorProps {
  value: string;
  teams: VaultSelectorTeam[];
  onValueChange: (value: string) => void;
}

export function VaultSelector({ value, teams, onValueChange }: VaultSelectorProps) {
  const teamOptions = teams;
  const t = useTranslations("Dashboard");

  if (teamOptions.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1">
      <p className="px-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {t("vault")}
      </p>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="personal">
            <Lock className="h-4 w-4" />
            {t("personalVault")}
          </SelectItem>
          {teamOptions.map((team) => (
            <SelectItem key={team.id} value={team.id}>
              <div className="flex items-start gap-2">
                {team.isCrossTenant ? (
                  <Globe className="h-4 w-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                ) : (
                  <Building2 className="h-4 w-4 mt-0.5 shrink-0" />
                )}
                <span className="flex flex-col items-start">
                  <span>{team.name}</span>
                  {team.isCrossTenant && (
                    <span className="text-xs text-amber-600 dark:text-amber-400">{team.tenantName}</span>
                  )}
                </span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
