"use client";

import { useTranslations } from "next-intl";
import { Bot, Cpu, KeyRound } from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";

export default function TenantMachineIdentityLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");

  const navItems = [
    { href: "/admin/tenant/machine-identity/service-accounts", label: t("navServiceAccounts"), icon: Bot },
    { href: "/admin/tenant/machine-identity/mcp-clients", label: t("navMcpClients"), icon: Cpu },
    { href: "/admin/tenant/machine-identity/access-requests", label: t("navAccessRequests"), icon: KeyRound },
  ];

  return (
    <SectionLayout
      icon={Bot}
      title={t("sectionMachineIdentity")}
      description={t("sectionMachineIdentityDesc")}
      navItems={navItems}
    >
      {children}
    </SectionLayout>
  );
}
