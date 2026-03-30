"use client";

import { useTranslations } from "next-intl";
import { Database, GitMerge } from "lucide-react";
import { SectionNav } from "@/components/settings/section-nav";

export default function TenantProvisioningLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");

  const navItems = [
    { href: "/admin/tenant/provisioning/scim", label: t("navScim"), icon: Database },
    { href: "/admin/tenant/provisioning/directory-sync", label: t("navDirectorySync"), icon: GitMerge },
  ];

  return (
    <div className="space-y-4">
      <SectionNav items={navItems} />
      {children}
    </div>
  );
}
