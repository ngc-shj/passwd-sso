"use client";

import { use } from "react";
import { useTranslations } from "next-intl";
import { ListChecks, Lock, Clock, Share2, Globe } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TeamPolicyLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const t = useTranslations("AdminConsole");

  const navItems = [
    { href: `/admin/teams/${teamId}/policy/password`, label: t("subTabPassword"), icon: Lock },
    { href: `/admin/teams/${teamId}/policy/session`, label: t("subTabSession"), icon: Clock },
    { href: `/admin/teams/${teamId}/policy/sharing`, label: t("subTabSharing"), icon: Share2 },
    { href: `/admin/teams/${teamId}/policy/access-restriction`, label: t("subTabAccessRestriction"), icon: Globe },
  ];

  return (
    <SectionLayout
      icon={ListChecks}
      title={t("teamSectionPolicy")}
      description={t("teamSectionPolicyDesc")}
      navItems={navItems}
    >
      {children}
    </SectionLayout>
  );
}
