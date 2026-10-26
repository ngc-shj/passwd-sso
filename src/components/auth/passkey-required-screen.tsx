"use client";

import { useLayoutEffect } from "react";
import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { Fingerprint } from "lucide-react";
import { PasskeyCredentialsCard } from "@/components/settings/security/passkey-credentials-card";
import { SignOutButton } from "@/components/auth/signout-button";
import {
  currentAppPath,
  hardNavigate,
  setPasskeyRequiredScreenMounted,
} from "@/lib/url-helpers";

/**
 * Rendered by the dashboard layout, in place of the vault gate and the
 * dashboard shell, while the tenant's passkey requirement blocks the session.
 * Everything it calls (the credential list, the auth-provider probe, the two
 * registration calls, sign-out) is exempt from the proxy's passkey gate, so a
 * blocked user can register without unlocking the vault.
 */
export function PasskeyRequiredScreen() {
  const t = useTranslations("Auth");
  const { update } = useSession();

  // Tells fetchApi's PASSKEY_REQUIRED reaction that this screen is already up,
  // so a refusal seen here never reloads the tab. A layout effect, so the flag
  // is set before the card's mount effects issue their first fetch.
  useLayoutEffect(() => {
    setPasskeyRequiredScreenMounted(true);
    return () => setPasskeyRequiredScreenMounted(false);
  }, []);

  // Refresh the client session first so it no longer reports passkeyBlocked,
  // then reload the page: the layout re-checks with a fresh auth() and the
  // vault status and auto-lock apply from a clean tree.
  const handleRegistered = async () => {
    await update();
    hardNavigate(currentAppPath());
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-2xl space-y-4">
        <div className="flex items-start gap-3">
          <Fingerprint className="mt-0.5 h-6 w-6 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">{t("passkeyRequiredTitle")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("passkeyRequiredDescription")}
            </p>
          </div>
        </div>
        <PasskeyCredentialsCard onRegistered={handleRegistered} />
        <div className="flex justify-end">
          <SignOutButton />
        </div>
      </div>
    </div>
  );
}
