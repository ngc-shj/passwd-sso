"use client";

import { useTranslations } from "next-intl";
import { TabDescription } from "@/components/settings/tab-description";
import { ScimProvisioningCard } from "@/components/settings/scim-provisioning-card";
import { DirectorySyncCard } from "@/components/settings/directory-sync-card";

export default function TenantProvisioningPage() {
  const t = useTranslations("Dashboard");

  return (
    <div className="space-y-4">
      <TabDescription>{t("tenantTabProvisioningDesc")}</TabDescription>
      <ScimProvisioningCard />
      <DirectorySyncCard />
    </div>
  );
}
