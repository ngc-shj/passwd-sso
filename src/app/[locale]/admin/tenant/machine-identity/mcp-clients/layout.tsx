"use client";

import { useTranslations } from "next-intl";
import { Blocks } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TenantMachineIdentityMcpClientsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("AdminConsole");

  return (
    <SectionLayout
      icon={Blocks}
      title={t("sectionMachineIdentityMcpClients")}
      description={t("sectionMachineIdentityMcpClientsDesc")}
    >
      {children}
    </SectionLayout>
  );
}
