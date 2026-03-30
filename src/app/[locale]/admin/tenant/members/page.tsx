"use client";

import { useTranslations } from "next-intl";
import { TabDescription } from "@/components/settings/tab-description";
import { TenantMembersCard } from "@/components/settings/tenant-members-card";

export default function TenantMembersPage() {
  const t = useTranslations("Dashboard");

  return (
    <div className="space-y-4">
      <TabDescription>{t("tenantTabMembersDesc")}</TabDescription>
      <TenantMembersCard />
    </div>
  );
}
