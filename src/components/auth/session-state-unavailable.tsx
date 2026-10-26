"use client";

import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SignOutButton } from "@/components/auth/signout-button";
import { currentAppPath, hardNavigate } from "@/lib/url-helpers";

/**
 * Rendered by the dashboard and admin layouts when the session callback could
 * not read the passkey state (a degraded session). That is an outage, not a
 * requirement: the user keeps their URL and retries, and a tenant that never
 * required passkeys is never sent to the passkey page.
 */
export function SessionStateUnavailable() {
  const t = useTranslations("Auth");
  const tc = useTranslations("Common");

  // A full reload, not a router refresh: the client session (which still
  // carries the degraded flag) must be re-read along with the layout.
  const handleRetry = () => {
    hardNavigate(currentAppPath());
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4 text-center">
      <AlertTriangle className="h-10 w-10 text-muted-foreground" />
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("sessionStateUnavailableTitle")}</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {t("sessionStateUnavailableDescription")}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={handleRetry}>{tc("tryAgain")}</Button>
        <SignOutButton />
      </div>
    </div>
  );
}
