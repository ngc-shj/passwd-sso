"use client";

import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TeamScopeOption } from "@/components/layout/team-scope-option";

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
              <TeamScopeOption
                name={team.name}
                tenantName={team.tenantName}
                isCrossTenant={team.isCrossTenant}
              />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
