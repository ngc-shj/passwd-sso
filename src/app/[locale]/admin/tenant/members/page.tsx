"use client";

import { useTranslations } from "next-intl";
import { Users } from "lucide-react";
import { AdminSectionLayout } from "@/components/admin/admin-section-layout";
import { TenantMembersCard } from "@/components/settings/tenant-members-card";

export default function TenantMembersPage() {
  const t = useTranslations("Dashboard");

  return (
    <AdminSectionLayout
      icon={Users}
      title={t("tenantTabMembers")}
      description={t("tenantTabMembersDesc")}
    >
      <TenantMembersCard />
    </AdminSectionLayout>
  );
}
