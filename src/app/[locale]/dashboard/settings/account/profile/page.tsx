"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { UserRound } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";

export default function ProfilePage() {
  const t = useTranslations("Settings");
  const { data: session, update } = useSession();

  const initialValue = session?.user?.fetchFavicons ?? false;
  const [fetchFavicons, setFetchFavicons] = useState(initialValue);

  const handleToggle = async (checked: boolean) => {
    // Optimistic update
    setFetchFavicons(checked);
    try {
      const res = await fetchApi(API_PATH.USER_FAVICON_PREF, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fetchFavicons: checked }),
      });
      if (!res.ok) {
        setFetchFavicons(!checked);
        toast.error(t("profile.siteIcons.saveError"));
        return;
      }
      // Refresh session so open Favicon components re-render
      await update();
    } catch {
      setFetchFavicons(!checked);
      toast.error(t("profile.siteIcons.saveError"));
    }
  };

  return (
    <Card>
      <SectionCardHeader
        icon={UserRound}
        title={t("subTab.profile")}
        description={t("profile.description")}
      />
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="site-icons-toggle">{t("profile.siteIcons.label")}</Label>
          <Switch
            id="site-icons-toggle"
            checked={fetchFavicons}
            onCheckedChange={(checked) => void handleToggle(checked)}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {fetchFavicons
            ? t("profile.siteIcons.descriptionOn")
            : t("profile.siteIcons.descriptionOff")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("profile.siteIcons.privacyFooter")}
        </p>
      </CardContent>
    </Card>
  );
}
