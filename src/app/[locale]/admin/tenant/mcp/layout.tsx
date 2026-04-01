"use client";

import { useTranslations } from "next-intl";
import { Cpu } from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";

export default function TenantMcpLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");

  return (
    <SectionLayout
      icon={Cpu}
      title={t("sectionMcp")}
      description={t("sectionMcpDesc")}
    >
      {children}
    </SectionLayout>
  );
}
