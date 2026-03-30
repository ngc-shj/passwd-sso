"use client";

import { useTranslations } from "next-intl";
import { Bot, Cpu, KeyRound, Share2 } from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";

export default function TenantMachineIdentityLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");
  const tDash = useTranslations("Dashboard");

  const navItems = [
    { href: "/admin/tenant/machine-identity/service-accounts", label: t("navServiceAccounts"), icon: Bot },
    { href: "/admin/tenant/machine-identity/mcp-clients", label: t("navMcpClients"), icon: Cpu },
    { href: "/admin/tenant/machine-identity/access-requests", label: t("navAccessRequests"), icon: KeyRound },
    { href: "/admin/tenant/machine-identity/delegation", label: t("navDelegation"), icon: Share2 },
  ];

  return (
    <SectionLayout
      icon={Bot}
      title={tDash("tenantTabMachineIdentity")}
      description={tDash("tenantTabMachineIdentityDesc")}
      navItems={navItems}
    >
      {children}
    </SectionLayout>
  );
}
