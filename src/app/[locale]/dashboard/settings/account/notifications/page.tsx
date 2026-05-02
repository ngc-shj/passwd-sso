"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function NotificationsSettingsPage() {
  const t = useTranslations("Settings");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("subTab.notifications")}</CardTitle>
      </CardHeader>
      <CardContent>
        {/* Notification preferences UI will be added in a future iteration. */}
      </CardContent>
    </Card>
  );
}
