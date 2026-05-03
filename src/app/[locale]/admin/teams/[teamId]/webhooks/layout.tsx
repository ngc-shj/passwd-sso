"use client";

import { useTranslations } from "next-intl";
import { Webhook } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TeamWebhooksLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");

  return (
    <SectionLayout
      icon={Webhook}
      title={t("teamSectionWebhooks")}
      description={t("teamSectionWebhooksDesc")}
    >
      {children}
    </SectionLayout>
  );
}
