"use client";

import { useTranslations } from "next-intl";
import { Bot, ShieldCheck } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TenantMachineIdentityServiceAccountsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("AdminConsole");

  const navItems = [
    {
      href: "/admin/tenant/machine-identity/service-accounts/accounts",
      label: t("subTabSaAccounts"),
      icon: Bot,
    },
    {
      href: "/admin/tenant/machine-identity/service-accounts/access-requests",
      label: t("subTabSaAccessRequests"),
      icon: ShieldCheck,
    },
  ];

  return (
    <SectionLayout
      icon={Bot}
      title={t("sectionMachineIdentityServiceAccounts")}
      description={t("sectionMachineIdentityServiceAccountsDesc")}
      navItems={navItems}
    >
      {children}
    </SectionLayout>
  );
}
