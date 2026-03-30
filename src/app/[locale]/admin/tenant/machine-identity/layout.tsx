"use client";

import { useTranslations } from "next-intl";
import { Bot, Cpu, KeyRound, Share2 } from "lucide-react";
import { SectionNav } from "@/components/settings/section-nav";

export default function TenantMachineIdentityLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");

  const navItems = [
    { href: "/admin/tenant/machine-identity/service-accounts", label: t("navServiceAccounts"), icon: Bot },
    { href: "/admin/tenant/machine-identity/mcp-clients", label: t("navMcpClients"), icon: Cpu },
    { href: "/admin/tenant/machine-identity/access-requests", label: t("navAccessRequests"), icon: KeyRound },
    { href: "/admin/tenant/machine-identity/delegation", label: t("navDelegation"), icon: Share2 },
  ];

  return (
    <div className="space-y-4">
      <SectionNav items={navItems} />
      {children}
    </div>
  );
}
