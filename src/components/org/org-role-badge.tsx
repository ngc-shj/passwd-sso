"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";

const roleColors: Record<string, string> = {
  OWNER: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  ADMIN: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  MEMBER: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  VIEWER: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
};

export function OrgRoleBadge({ role }: { role: string }) {
  const t = useTranslations("Org");

  const roleKeys: Record<string, string> = {
    OWNER: "roleOwner",
    ADMIN: "roleAdmin",
    MEMBER: "roleMember",
    VIEWER: "roleViewer",
  };

  return (
    <Badge variant="outline" className={roleColors[role] ?? ""}>
      {t(roleKeys[role] ?? "roleMember")}
    </Badge>
  );
}
