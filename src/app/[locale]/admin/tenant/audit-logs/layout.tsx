"use client";

import { useTranslations } from "next-intl";
import { ScrollText } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TenantAuditLogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("AdminConsole");

  return (
    <SectionLayout
      icon={ScrollText}
      title={t("sectionAuditLogs")}
      description={t("sectionAuditLogsDesc")}
    >
      {children}
    </SectionLayout>
  );
}
