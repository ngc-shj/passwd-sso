"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { ORG_ROLE } from "@/lib/constants";

const roleColors: Record<string, string> = {
  [ORG_ROLE.OWNER]: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  [ORG_ROLE.ADMIN]: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  [ORG_ROLE.MEMBER]: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  [ORG_ROLE.VIEWER]: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
};

export function TeamRoleBadge({ role }: { role: string }) {
  const t = useTranslations("Team");

  const roleKeys: Record<string, string> = {
    [ORG_ROLE.OWNER]: "roleOwner",
    [ORG_ROLE.ADMIN]: "roleAdmin",
    [ORG_ROLE.MEMBER]: "roleMember",
    [ORG_ROLE.VIEWER]: "roleViewer",
  };

  return (
    <Badge variant="outline" className={roleColors[role] ?? ""}>
      {t(roleKeys[role] ?? "roleMember")}
    </Badge>
  );
}
