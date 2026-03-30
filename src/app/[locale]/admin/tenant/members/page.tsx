"use client";

import { useTranslations } from "next-intl";
import { Users } from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";
import { TenantMembersCard } from "@/components/settings/tenant-members-card";

export default function TenantMembersPage() {
  const t = useTranslations("Dashboard");

  return (
    <SectionLayout
      icon={Users}
      title={t("tenantTabMembers")}
      description={t("tenantTabMembersDesc")}
    >
      <TenantMembersCard />
    </SectionLayout>
  );
}
