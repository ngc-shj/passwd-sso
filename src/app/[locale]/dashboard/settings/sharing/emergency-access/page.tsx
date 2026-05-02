"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function EmergencyAccessSettingsPage() {
  const t = useTranslations("Settings");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("subTab.emergencyAccess")}</CardTitle>
      </CardHeader>
      <CardContent>
        {/* Emergency access configuration UI will be added in a future iteration. */}
        {/* The recipient-side emergency access flow remains at /dashboard/emergency-access. */}
      </CardContent>
    </Card>
  );
}
