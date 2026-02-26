"use client";

import { Building2, Lock } from "lucide-react";
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
}

interface VaultSelectorProps {
  value: string;
  teams?: VaultSelectorTeam[];
  orgs?: VaultSelectorTeam[];
  onValueChange: (value: string) => void;
}

export function VaultSelector({ value, teams, orgs, onValueChange }: VaultSelectorProps) {
  const teamOptions = teams ?? orgs ?? [];
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
              <Building2 className="h-4 w-4" />
              {team.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
