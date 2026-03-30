"use client";

import { useTranslations } from "next-intl";
import { TabDescription } from "@/components/settings/tab-description";
import { ServiceAccountCard } from "@/components/settings/service-account-card";
import { McpClientCard } from "@/components/settings/mcp-client-card";
import { AccessRequestCard } from "@/components/settings/access-request-card";
import { DelegationManager } from "@/components/settings/delegation-manager";

export default function TenantMachineIdentityPage() {
  const t = useTranslations("Dashboard");

  return (
    <div className="space-y-4">
      <TabDescription>{t("tenantTabMachineIdentityDesc")}</TabDescription>
      <ServiceAccountCard />
      <McpClientCard />
      <AccessRequestCard />
      <DelegationManager />
    </div>
  );
}
