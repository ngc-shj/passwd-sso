"use client";

import { useTranslations } from "next-intl";
import { ShieldAlert } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TenantBreakglassLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("AdminConsole");

  return (
    <SectionLayout
      icon={ShieldAlert}
      title={t("sectionBreakglass")}
      description={t("sectionBreakglassDesc")}
    >
      {children}
    </SectionLayout>
  );
}
