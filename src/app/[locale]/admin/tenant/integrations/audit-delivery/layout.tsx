"use client";

import { useTranslations } from "next-intl";
import { Send } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TenantIntegrationsAuditDeliveryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("AdminConsole");

  return (
    <SectionLayout
      icon={Send}
      title={t("sectionIntegrationAuditDelivery")}
      description={t("sectionIntegrationAuditDeliveryDesc")}
    >
      {children}
    </SectionLayout>
  );
}
