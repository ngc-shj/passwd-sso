"use client";

import { use } from "react";
import { useTranslations } from "next-intl";
import { Users, List, Crown } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TeamMembersLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const t = useTranslations("AdminConsole");

  const navItems = [
    {
      href: `/admin/teams/${teamId}/members/list`,
      label: t("subTabMembersList"),
      icon: List,
    },
    {
      href: `/admin/teams/${teamId}/members/transfer-ownership`,
      label: t("subTabMembersTransferOwnership"),
      icon: Crown,
    },
  ];

  return (
    <SectionLayout
      icon={Users}
      title={t("teamSectionMembers")}
      description={t("teamSectionMembersDesc")}
      navItems={navItems}
    >
      {children}
    </SectionLayout>
  );
}
