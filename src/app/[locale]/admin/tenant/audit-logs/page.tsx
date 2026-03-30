"use client";

import { useTranslations } from "next-intl";
import { TabDescription } from "@/components/settings/tab-description";
import { TenantAuditLogCard } from "@/components/settings/tenant-audit-log-card";

export default function TenantAuditLogsPage() {
  const t = useTranslations("Dashboard");

  return (
    <div className="space-y-4">
      <TabDescription>{t("tenantTabAuditLogDesc")}</TabDescription>
      <TenantAuditLogCard />
    </div>
  );
}
