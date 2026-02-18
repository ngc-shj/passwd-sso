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

interface VaultSelectorOrg {
  id: string;
  name: string;
}

interface VaultSelectorProps {
  value: string;
  orgs: VaultSelectorOrg[];
  onValueChange: (value: string) => void;
}

export function VaultSelector({ value, orgs, onValueChange }: VaultSelectorProps) {
  const t = useTranslations("Dashboard");

  if (orgs.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1">
      <p className="px-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
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
          {orgs.map((org) => (
            <SelectItem key={org.id} value={org.id}>
              <Building2 className="h-4 w-4" />
              {org.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
