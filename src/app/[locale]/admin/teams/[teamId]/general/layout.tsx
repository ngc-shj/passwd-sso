"use client";

import { use } from "react";
import { useTranslations } from "next-intl";
import { Settings2, User, Trash2 } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TeamGeneralLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const t = useTranslations("AdminConsole");

  const navItems = [
    { href: `/admin/teams/${teamId}/general/profile`, label: t("subTabProfile"), icon: User },
    { href: `/admin/teams/${teamId}/general/delete`, label: t("subTabDelete"), icon: Trash2 },
  ];

  return (
    <SectionLayout
      icon={Settings2}
      title={t("teamSectionGeneral")}
      description={t("teamSectionGeneralDesc")}
      navItems={navItems}
    >
      {children}
    </SectionLayout>
  );
}
