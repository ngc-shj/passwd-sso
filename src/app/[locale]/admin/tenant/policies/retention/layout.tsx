"use client";

import { useTranslations } from "next-intl";
import { Archive } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TenantPoliciesRetentionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("AdminConsole");

  return (
    <SectionLayout
      icon={Archive}
      title={t("sectionPolicyRetention")}
      description={t("sectionPolicyRetentionDesc")}
    >
      {children}
    </SectionLayout>
  );
}
