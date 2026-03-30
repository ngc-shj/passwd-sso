"use client";

import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { Users, UserPlus, Crown } from "lucide-react";
import { SectionNav } from "@/components/settings/section-nav";

export default function TeamMembersLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");
  const pathname = usePathname();
  const teamIdMatch = pathname.match(/\/admin\/teams\/([^/]+)\//);
  const teamId = teamIdMatch?.[1] ?? "";

  const navItems = [
    { href: `/admin/teams/${teamId}/members/list`, label: t("navMemberList"), icon: Users },
    { href: `/admin/teams/${teamId}/members/add`, label: t("navAddMember"), icon: UserPlus },
    { href: `/admin/teams/${teamId}/members/transfer`, label: t("navTransferOwnership"), icon: Crown },
  ];

  return (
    <div className="space-y-4">
      <SectionNav items={navItems} />
      {children}
    </div>
  );
}
