"use client";

import { useTranslations } from "next-intl";
import { ScrollText } from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";
import { TenantAuditLogCard } from "@/components/settings/tenant-audit-log-card";

export default function TenantAuditLogsPage() {
  const t = useTranslations("Dashboard");

  return (
    <SectionLayout
      icon={ScrollText}
      title={t("tenantTabAuditLog")}
      description={t("tenantTabAuditLogDesc")}
    >
      <TenantAuditLogCard />
    </SectionLayout>
  );
}
