"use client";

import { useTranslations } from "next-intl";
import { ShieldBan } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TenantPoliciesAccessRestrictionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("AdminConsole");

  return (
    <SectionLayout
      icon={ShieldBan}
      title={t("sectionPolicyAccessRestriction")}
      description={t("sectionPolicyAccessRestrictionDesc")}
    >
      {children}
    </SectionLayout>
  );
}
