"use client";

import { useTranslations } from "next-intl";
import { Bell } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";

export default function NotificationsSettingsPage() {
  const t = useTranslations("Settings");

  return (
    <Card>
      <SectionCardHeader
        icon={Bell}
        title={t("subTab.notifications")}
        description={t("notifications.description")}
      />
      <CardContent>
        <p className="text-sm text-muted-foreground">{t("comingSoon")}</p>
      </CardContent>
    </Card>
  );
}
