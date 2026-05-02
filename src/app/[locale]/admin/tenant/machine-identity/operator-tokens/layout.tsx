"use client";

import { useTranslations } from "next-intl";
import { KeyRound } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TenantOperatorTokensLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("AdminConsole");

  return (
    <SectionLayout
      icon={KeyRound}
      title={t("sectionMachineIdentityOperatorTokens")}
      description={t("sectionMachineIdentityOperatorTokensDesc")}
    >
      {children}
    </SectionLayout>
  );
}
