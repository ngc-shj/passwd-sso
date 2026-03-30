"use client";

import { useTranslations } from "next-intl";
import { Bot } from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";

export default function TenantMachineIdentityLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");

  return (
    <SectionLayout
      icon={Bot}
      title={t("sectionMachineIdentity")}
      description={t("sectionMachineIdentityDesc")}
    >
      {children}
    </SectionLayout>
  );
}
