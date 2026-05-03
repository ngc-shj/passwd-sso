"use client";

import { useTranslations } from "next-intl";
import { Handshake, Database, FolderSync } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TenantIntegrationsProvisioningLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("AdminConsole");

  const navItems = [
    { href: "/admin/tenant/integrations/provisioning/scim", label: t("subTabScim"), icon: Database },
    { href: "/admin/tenant/integrations/provisioning/directory-sync", label: t("subTabDirectorySync"), icon: FolderSync },
  ];

  return (
    <SectionLayout
      icon={Handshake}
      title={t("sectionIntegrationProvisioning")}
      description={t("sectionIntegrationProvisioningDesc")}
      navItems={navItems}
    >
      {children}
    </SectionLayout>
  );
}
