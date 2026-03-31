"use client";

import { useTranslations } from "next-intl";
import { Shield } from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";

export default function TenantSecurityLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");

  return (
    <SectionLayout
      icon={Shield}
      title={t("sectionSecurity")}
      description={t("sectionSecurityDesc")}
    >
      {children}
    </SectionLayout>
  );
}
