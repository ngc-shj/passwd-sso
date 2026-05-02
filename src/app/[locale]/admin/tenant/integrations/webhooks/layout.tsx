"use client";

import { useTranslations } from "next-intl";
import { Webhook } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TenantIntegrationsWebhooksLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("AdminConsole");

  return (
    <SectionLayout
      icon={Webhook}
      title={t("sectionIntegrationWebhooks")}
      description={t("sectionIntegrationWebhooksDesc")}
    >
      {children}
    </SectionLayout>
  );
}
