"use client";

import { useTranslations } from "next-intl";
import { TabDescription } from "@/components/settings/tab-description";
import { PasskeyCredentialsCard } from "@/components/settings/passkey-credentials-card";
import { TravelModeCard } from "@/components/settings/travel-mode-card";
import { RotateKeyCard } from "@/components/settings/rotate-key-card";

export default function SettingsSecurityPage() {
  const t = useTranslations("Sessions");
  return (
    <>
      <TabDescription>{t("tabSecurityDesc")}</TabDescription>
      <PasskeyCredentialsCard />
      <TravelModeCard />
      <RotateKeyCard />
    </>
  );
}
