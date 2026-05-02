"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function ProfilePage() {
  const t = useTranslations("Settings");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("subTab.profile")}</CardTitle>
      </CardHeader>
      <CardContent>
        {/* Profile management UI will be added in a future iteration. */}
      </CardContent>
    </Card>
  );
}
