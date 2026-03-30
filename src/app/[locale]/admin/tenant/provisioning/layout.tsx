"use client";

import { useTranslations } from "next-intl";
import { Link2 } from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";

export default function TenantProvisioningLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");

  return (
    <SectionLayout
      icon={Link2}
      title={t("sectionProvisioning")}
      description={t("sectionProvisioningDesc")}
    >
      {children}
    </SectionLayout>
  );
}
