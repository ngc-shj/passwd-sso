"use client";

import { useTranslations } from "next-intl";
import { TabDescription } from "@/components/settings/tab-description";
import { SessionsCard } from "@/components/sessions/sessions-card";

export default function SettingsAccountPage() {
  const t = useTranslations("Sessions");
  return (
    <>
      <TabDescription>{t("tabAccountDesc")}</TabDescription>
      <SessionsCard />
    </>
  );
}
