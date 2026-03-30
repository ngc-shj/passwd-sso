"use client";

import { useTranslations } from "next-intl";
import { ScrollText, ShieldAlert } from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";

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
      navItems={[
        {
          href: "/admin/tenant/audit-logs/logs",
          label: t("navAuditLogsLogs"),
          icon: ScrollText,
        },
        {
          href: "/admin/tenant/audit-logs/breakglass",
          label: t("navAuditLogsBreakglass"),
          icon: ShieldAlert,
        },
      ]}
    >
      {children}
    </SectionLayout>
  );
}
