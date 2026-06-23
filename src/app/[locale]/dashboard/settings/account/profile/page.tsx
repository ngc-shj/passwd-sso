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

  // Source of truth is the persisted preference on the session (a live DB
  // projection). The session resolves AFTER first paint, so we derive the
  // checked state from it rather than snapshotting into useState. `optimistic`
  // is a transient override applied only while a toggle's PUT is in flight; it
  // clears once the session catches up (or on rollback).
  const persisted = session?.user?.fetchFavicons ?? false;
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const fetchFavicons = optimistic ?? persisted;

  const handleToggle = async (checked: boolean) => {
    setOptimistic(checked); // optimistic
    try {
      const res = await fetchApi(API_PATH.USER_FAVICON_PREF, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fetchFavicons: checked }),
      });
      if (!res.ok) {
        setOptimistic(null); // roll back to persisted
        toast.error(t("profile.siteIcons.saveError"));
        return;
      }
      // Refresh session so open Favicon components re-render; once the session
      // reflects the new value, drop the optimistic override.
      await update();
      setOptimistic(null);
    } catch {
      setOptimistic(null);
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
