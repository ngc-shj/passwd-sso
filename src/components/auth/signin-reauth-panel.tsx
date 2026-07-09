"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { useLocale } from "next-intl";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AppIcon } from "@/components/ui/app-icon";
import { reauthenticateWithPasskey } from "@/lib/auth/webauthn/passkey-reauth-client";
import { withBasePath } from "@/lib/url-helpers";

/**
 * Server-computed callback paths must be same-origin root-relative: exactly
 * one leading slash. A protocol-relative value (`//host` — or `/\host`,
 * which browsers normalize to `//host`) would turn the post-reauth
 * navigation into an open redirect — refuse it outright rather than
 * trusting upstream validation alone.
 */
const SAFE_CALLBACK_HREF_RE = /^\/(?![/\\])/;

type SignInReauthPanelLabels = {
  title: string;
  description: string;
  passkeyAction: string;
  passkeyFailed: string;
  passkeyCancelled: string;
  signInAgainAction: string;
};

type SignInReauthPanelProps = {
  /** basePath-qualified same-origin path (window.location gets no framework re-prepend). */
  callbackHref: string;
  canUsePasskey: boolean;
  labels: SignInReauthPanelLabels;
};

/**
 * Rendered by the sign-in page when an authenticated user arrives with a
 * step-up-gated API callback (MCP / iOS OAuth authorize) and a stale session.
 * Recovery mirrors the in-app step-up pattern: passkey ceremony for
 * webauthn-established sessions (refreshes `passkeyVerifiedAt`, keeps the
 * session), sign-out + fresh sign-in for everything else (mints a session
 * with a fresh `createdAt`). The sign-in-again action is always offered so a
 * user whose passkeys were deleted after sign-in is never stranded.
 */
export function SignInReauthPanel({
  callbackHref,
  canUsePasskey,
  labels,
}: SignInReauthPanelProps) {
  const locale = useLocale();
  const [busy, setBusy] = useState<"passkey" | "signout" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const safeHref = SAFE_CALLBACK_HREF_RE.test(callbackHref)
    ? callbackHref
    : null;

  const handlePasskey = async () => {
    if (!safeHref) return;
    setBusy("passkey");
    setError(null);
    // try/finally: a network-level rejection (fetchApi throw, malformed body)
    // must not strand the panel with both buttons permanently disabled —
    // recovery-liveness is the whole point of this component.
    try {
      const result = await reauthenticateWithPasskey();
      if (result.ok) {
        window.location.assign(safeHref);
        return;
      }
      setError(
        result.error === "AUTHENTICATION_CANCELLED"
          ? labels.passkeyCancelled
          : labels.passkeyFailed,
      );
    } catch {
      setError(labels.passkeyFailed);
    } finally {
      setBusy(null);
    }
  };

  const handleSignInAgain = async () => {
    setBusy("signout");
    const signInPath = `${withBasePath(`/${locale}/auth/signin`)}${
      safeHref ? `?callbackUrl=${encodeURIComponent(safeHref)}` : ""
    }`;
    try {
      await signOut({ callbackUrl: signInPath });
    } catch {
      // Success navigates away; only a failure needs the buttons back.
      setBusy(null);
    }
  };

  const showPasskey = canUsePasskey && safeHref !== null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center space-y-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <AppIcon className="h-7 w-7" />
          </div>
          <div>
            <CardTitle className="text-2xl">{labels.title}</CardTitle>
            <p className="mt-2 text-sm text-muted-foreground">
              {labels.description}
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <p className="text-sm text-destructive text-center">{error}</p>
          )}
          {showPasskey && (
            <Button
              className="w-full"
              onClick={handlePasskey}
              disabled={busy !== null}
            >
              {busy === "passkey" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                labels.passkeyAction
              )}
            </Button>
          )}
          <Button
            variant={showPasskey ? "outline" : "default"}
            className="w-full"
            onClick={handleSignInAgain}
            disabled={busy !== null}
          >
            {busy === "signout" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              labels.signInAgainAction
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
