"use client";

import { useTranslations } from "next-intl";
import { Users } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";
import { TenantMembersCard } from "@/components/settings/account/tenant-members-card";

export default function TenantMembersPage() {
  const t = useTranslations("AdminConsole");

  return (
    <SectionLayout
      icon={Users}
      title={t("sectionMembers")}
      description={t("sectionMembersDesc")}
    >
      <TenantMembersCard />
    </SectionLayout>
  );
}
