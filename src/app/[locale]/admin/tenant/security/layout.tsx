"use client";

import { useTranslations } from "next-intl";
import { Shield, Clock, ShieldBan, Webhook } from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";

export default function TenantSecurityLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");
  const tDash = useTranslations("Dashboard");

  const navItems = [
    { href: "/admin/tenant/security/session-policy", label: t("navSessionPolicy"), icon: Clock },
    { href: "/admin/tenant/security/access-restriction", label: t("navAccessRestriction"), icon: ShieldBan },
    { href: "/admin/tenant/security/webhooks", label: t("navWebhooks"), icon: Webhook },
  ];

  return (
    <SectionLayout
      icon={Shield}
      title={tDash("tenantTabSecurity")}
      description={tDash("tenantTabSecurityDesc")}
      navItems={navItems}
    >
      {children}
    </SectionLayout>
  );
}
