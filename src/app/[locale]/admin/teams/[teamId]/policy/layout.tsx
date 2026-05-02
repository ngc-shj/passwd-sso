"use client";

import { useTranslations } from "next-intl";
import { ListChecks } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TeamPolicyLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");

  return (
    <SectionLayout
      icon={ListChecks}
      title={t("teamSectionPolicy")}
      description={t("teamSectionPolicyDesc")}
    >
      {children}
    </SectionLayout>
  );
}
