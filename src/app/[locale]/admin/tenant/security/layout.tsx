"use client";

import { useTranslations } from "next-intl";
import { Clock, ShieldBan, Webhook } from "lucide-react";
import { SectionNav } from "@/components/settings/section-nav";

export default function TenantSecurityLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");

  const navItems = [
    { href: "/admin/tenant/security/session-policy", label: t("navSessionPolicy"), icon: Clock },
    { href: "/admin/tenant/security/access-restriction", label: t("navAccessRestriction"), icon: ShieldBan },
    { href: "/admin/tenant/security/webhooks", label: t("navWebhooks"), icon: Webhook },
  ];

  return (
    <div className="space-y-4">
      <SectionNav items={navItems} />
      {children}
    </div>
  );
}
