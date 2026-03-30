"use client";

import { Building2, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface AdminTeam {
  team: { id: string; name: string; slug: string };
}

interface AdminScopeSelectorProps {
  adminTeams: AdminTeam[];
}

function currentScope(pathname: string): string {
  const match = pathname.match(/\/admin\/teams\/([^/]+)/);
  if (match) return match[1];
  return "tenant";
}

export function AdminScopeSelector({ adminTeams }: AdminScopeSelectorProps) {
  const t = useTranslations("AdminConsole");
  const pathname = usePathname();
  const router = useRouter();

  const value = currentScope(pathname);

  function handleValueChange(next: string) {
    if (next === "tenant") {
      router.push("/admin/tenant/members");
    } else {
      router.push(`/admin/teams/${next}/general`);
    }
  }

  return (
    <div className="space-y-1 px-2 pt-2">
      <p className="px-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {t("scopeLabel")}
      </p>
      <Select value={value} onValueChange={handleValueChange}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="tenant">
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 shrink-0" />
              <span>{t("scopeTenant")}</span>
            </div>
          </SelectItem>
          {adminTeams.map(({ team }) => (
            <SelectItem key={team.id} value={team.id}>
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 shrink-0" />
                <span>{team.name}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
