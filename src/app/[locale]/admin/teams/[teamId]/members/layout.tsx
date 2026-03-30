"use client";

import { useTranslations } from "next-intl";
import { Users } from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";

export default function TeamMembersLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");

  return (
    <SectionLayout
      icon={Users}
      title={t("teamSectionMembers")}
      description={t("teamSectionMembersDesc")}
    >
      {children}
    </SectionLayout>
  );
}
