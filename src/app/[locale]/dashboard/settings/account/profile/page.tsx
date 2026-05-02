"use client";

import { useTranslations } from "next-intl";
import { UserRound } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";

export default function ProfilePage() {
  const t = useTranslations("Settings");

  return (
    <Card>
      <SectionCardHeader
        icon={UserRound}
        title={t("subTab.profile")}
        description={t("profile.description")}
      />
      <CardContent>
        <p className="text-sm text-muted-foreground">{t("comingSoon")}</p>
      </CardContent>
    </Card>
  );
}
