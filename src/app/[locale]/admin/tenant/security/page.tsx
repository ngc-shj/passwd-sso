"use client";

import { useTranslations } from "next-intl";
import { TabDescription } from "@/components/settings/tab-description";
import { TenantSessionPolicyCard } from "@/components/settings/tenant-session-policy-card";
import { TenantAccessRestrictionCard } from "@/components/settings/tenant-access-restriction-card";
import { TenantWebhookCard } from "@/components/settings/tenant-webhook-card";

export default function TenantSecurityPage() {
  const t = useTranslations("Dashboard");

  return (
    <div className="space-y-4">
      <TabDescription>{t("tenantTabSecurityDesc")}</TabDescription>
      <TenantSessionPolicyCard />
      <TenantAccessRestrictionCard />
      <TenantWebhookCard />
    </div>
  );
}
