"use client";

import { useTranslations } from "next-intl";
import { ScrollText } from "lucide-react";
import { AdminSectionLayout } from "@/components/admin/admin-section-layout";
import { TenantAuditLogCard } from "@/components/settings/tenant-audit-log-card";

export default function TenantAuditLogsPage() {
  const t = useTranslations("Dashboard");

  return (
    <AdminSectionLayout
      icon={ScrollText}
      title={t("tenantTabAuditLog")}
      description={t("tenantTabAuditLogDesc")}
    >
      <TenantAuditLogCard />
    </AdminSectionLayout>
  );
}
