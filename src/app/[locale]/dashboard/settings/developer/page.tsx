"use client";

import { useTranslations } from "next-intl";
import { TabDescription } from "@/components/settings/tab-description";
import { CliTokenCard } from "@/components/settings/cli-token-card";
import { ApiKeyManager } from "@/components/settings/api-key-manager";

export default function SettingsDeveloperPage() {
  const t = useTranslations("Sessions");
  return (
    <>
      <TabDescription>{t("tabDeveloperDesc")}</TabDescription>
      <CliTokenCard />
      <ApiKeyManager />
    </>
  );
}
