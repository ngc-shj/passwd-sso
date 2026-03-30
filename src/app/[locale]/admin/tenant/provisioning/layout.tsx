"use client";

import { useTranslations } from "next-intl";
import { Link2, Database, GitMerge } from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";

export default function TenantProvisioningLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");
  const tDash = useTranslations("Dashboard");

  const navItems = [
    { href: "/admin/tenant/provisioning/scim", label: t("navScim"), icon: Database },
    { href: "/admin/tenant/provisioning/directory-sync", label: t("navDirectorySync"), icon: GitMerge },
  ];

  return (
    <SectionLayout
      icon={Link2}
      title={tDash("tenantTabProvisioning")}
      description={tDash("tenantTabProvisioningDesc")}
      navItems={navItems}
    >
      {children}
    </SectionLayout>
  );
}
