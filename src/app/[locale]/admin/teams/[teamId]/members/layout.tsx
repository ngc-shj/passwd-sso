"use client";

import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { Users, UserPlus, Crown } from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";

export default function TeamMembersLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");
  const tTeam = useTranslations("Team");
  const pathname = usePathname();
  const teamIdMatch = pathname.match(/\/admin\/teams\/([^/]+)\//);
  const teamId = teamIdMatch?.[1] ?? "";

  const navItems = [
    { href: `/admin/teams/${teamId}/members/list`, label: t("navMemberList"), icon: Users },
    { href: `/admin/teams/${teamId}/members/add`, label: t("navAddMember"), icon: UserPlus },
    { href: `/admin/teams/${teamId}/members/transfer`, label: t("navTransferOwnership"), icon: Crown },
  ];

  return (
    <SectionLayout
      icon={Users}
      title={tTeam("members")}
      description={tTeam("tabMembersDesc")}
      navItems={navItems}
    >
      {children}
    </SectionLayout>
  );
}
