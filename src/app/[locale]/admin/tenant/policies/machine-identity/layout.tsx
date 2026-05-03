"use client";

import { useTranslations } from "next-intl";
import { Cpu, Key, Handshake } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TenantPoliciesMachineIdentityLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("AdminConsole");

  const navItems = [
    { href: "/admin/tenant/policies/machine-identity/token", label: t("subTabToken"), icon: Key },
    { href: "/admin/tenant/policies/machine-identity/delegation", label: t("subTabDelegation"), icon: Handshake },
  ];

  return (
    <SectionLayout
      icon={Cpu}
      title={t("sectionPolicyMachineIdentity")}
      description={t("sectionPolicyMachineIdentityDesc")}
      navItems={navItems}
    >
      {children}
    </SectionLayout>
  );
}
