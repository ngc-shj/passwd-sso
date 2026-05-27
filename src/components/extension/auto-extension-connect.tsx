"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  APP_NAME,
  EXT_CONNECT_PARAM,
  CONNECT_STATUS,
  type ConnectStatus,
} from "@/lib/constants";
import {
  requestExtensionConnect,
  EXTENSION_CONNECT_ERROR_CODE,
} from "@/lib/extension-connect-request";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, Loader2, KeyRound } from "lucide-react";
import { withBasePath } from "@/lib/url-helpers";
import { reauthenticateWithPasskey } from "@/lib/auth/webauthn/passkey-reauth-client";
import { canUsePasskeyRecovery } from "@/lib/auth/webauthn/can-use-passkey-recovery";
import { signOut } from "next-auth/react";

/**
 * Returns true when a full-screen overlay with `data-overlay-active` is
 * present in the DOM. Used by keyboard-shortcut handlers to suppress
 * shortcuts while an overlay covers the page.
 *
 * Client-side only — must not be called during SSR.
 */
export function isOverlayActive(): boolean {
  return !!document.querySelector("[data-overlay-active]");
}

/**
 * Automatically connects the browser extension after vault unlock
 * when the page was opened from the extension (indicated by ?ext_connect=1).
 *
 * Shows a full-page connection status UI instead of the dashboard.
 */
export function AutoExtensionConnect() {
  const t = useTranslations("Extension");
  const locale = useLocale();
  const didRunRef = useRef(false);
  const [status, setStatus] = useState<ConnectStatus>(CONNECT_STATUS.IDLE);
  const [requiresReauth, setRequiresReauth] = useState(false);
  const [requiresRecentSession, setRequiresRecentSession] = useState(false);
  const [requiresExtensionUpdate, setRequiresExtensionUpdate] = useState(false);
  const [reauthenticating, setReauthenticating] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);

  const connect = useCallback(async (): Promise<{ ok: boolean; requiresReauth: boolean }> => {
    setStatus(CONNECT_STATUS.CONNECTING);
    setRequiresReauth(false);
    setRequiresRecentSession(false);
    setRequiresExtensionUpdate(false);
    setReauthError(null);
    try {
      // The extension SW does the whole bridge-code → exchange flow itself;
      // the web app just kicks it off and consumes the {ok, errorCode}.
      // The bridge code and bearer token never reach this page.
      const result = await requestExtensionConnect();
      if (result.ok) {
        setStatus(CONNECT_STATUS.CONNECTED);
        return { ok: true, requiresReauth: false };
      }

      if (result.errorCode === EXTENSION_CONNECT_ERROR_CODE.EXTENSION_ABSENT) {
        setRequiresExtensionUpdate(true);
        setStatus(CONNECT_STATUS.FAILED);
        return { ok: false, requiresReauth: false };
      }

      if (result.errorCode === EXTENSION_CONNECT_ERROR_CODE.SESSION_STEP_UP_REQUIRED) {
        const passkeyCapable = await canUsePasskeyRecovery();
        setRequiresReauth(passkeyCapable);
        setRequiresRecentSession(!passkeyCapable);
        setStatus(CONNECT_STATUS.FAILED);
        return { ok: false, requiresReauth: true };
      }

      setStatus(CONNECT_STATUS.FAILED);
      return { ok: false, requiresReauth: false };
    } catch {
      setStatus(CONNECT_STATUS.FAILED);
      return { ok: false, requiresReauth: false };
    }
  }, []);

  useEffect(() => {
    if (didRunRef.current) return;

    const params = new URLSearchParams(window.location.search);
    if (!params.has(EXT_CONNECT_PARAM)) return;

    didRunRef.current = true;

    // PROTOTYPE C15-v2: instead of auto-firing connect() from useEffect (which
    // an XSS payload can mimic on page load), surface a button and require a
    // real user click. The click satisfies navigator.userActivation.isActive
    // at the moment of window.postMessage — a flag XSS cannot forge because
    // programmatic .click() does NOT set user activation per W3C spec.
    setStatus(CONNECT_STATUS.AWAITING_CLICK);
  }, []);

  const handleConnectClick = useCallback(async () => {
    // PROTOTYPE C15-v2: empirical confirmation that the click yields
    // isActive=true. Remove before any production PR.
    // eslint-disable-next-line no-console
    console.log("[C15-v2 click] userActivation at click handler entry", {
      isActive: navigator.userActivation?.isActive,
      hasBeenActive: navigator.userActivation?.hasBeenActive,
    });

    // Remove ext_connect from URL so reload does not re-prompt.
    const params = new URLSearchParams(window.location.search);
    params.delete(EXT_CONNECT_PARAM);
    const newSearch = params.toString();
    const newUrl =
      window.location.pathname + (newSearch ? `?${newSearch}` : "") + window.location.hash;
    window.history.replaceState(null, "", newUrl);

    await connect();
  }, [connect]);

  const handleRetry = async () => {
    if (!requiresReauth) {
      if (requiresRecentSession) {
        setReauthenticating(true);
        try {
          const currentUrl = new URL(window.location.href);
          currentUrl.searchParams.set(EXT_CONNECT_PARAM, "1");
          const callbackUrl =
            `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
          const signInPath = `${withBasePath(`/${locale}/auth/signin`)}?callbackUrl=${encodeURIComponent(callbackUrl)}`;
          await signOut({ callbackUrl: signInPath });
        } finally {
          setReauthenticating(false);
        }
        return;
      }
      await connect();
      return;
    }

    setReauthenticating(true);
    setReauthError(null);
    try {
      const result = await reauthenticateWithPasskey();
      if (!result.ok) {
        setReauthError(
          result.error === "AUTHENTICATION_CANCELLED"
            ? t("connectReauthCancelled")
            : t("connectReauthFailed"),
        );
        return;
      }

      const retryResult = await connect();
      if (!retryResult.ok && retryResult.requiresReauth) {
        setReauthError(t("connectReauthStillRequired"));
      }
    } finally {
      setReauthenticating(false);
    }
  };

  // No ext_connect param — render nothing, let dashboard show
  if (status === CONNECT_STATUS.IDLE) return null;

  return (
    <div data-overlay-active className="fixed inset-0 z-50 flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center text-center pt-8 pb-8 space-y-6">
          {/* Icon */}
          {status === CONNECT_STATUS.AWAITING_CLICK && (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <KeyRound className="h-8 w-8 text-primary" />
            </div>
          )}
          {status === CONNECT_STATUS.CONNECTING && (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          )}
          {status === CONNECT_STATUS.CONNECTED && (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
              <CheckCircle2 className="h-8 w-8 text-green-600" />
            </div>
          )}
          {status === CONNECT_STATUS.FAILED && (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
              <XCircle className="h-8 w-8 text-red-600" />
            </div>
          )}

          {/* App branding */}
          <div className="flex items-center gap-2 text-muted-foreground">
            <KeyRound className="h-4 w-4" />
            <span className="text-sm font-medium">{APP_NAME}</span>
          </div>

          {/* Title & Description */}
          {status === CONNECT_STATUS.AWAITING_CLICK && (
            <div className="space-y-2">
              <h1 className="text-xl font-semibold">{t("awaitingClickTitle")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("awaitingClickDescription")}
              </p>
            </div>
          )}
          {status === CONNECT_STATUS.CONNECTING && (
            <div className="space-y-2">
              <h1 className="text-xl font-semibold">{t("connecting")}</h1>
            </div>
          )}
          {status === CONNECT_STATUS.CONNECTED && (
            <div className="space-y-2">
              <h1 className="text-xl font-semibold">{t("connectedTitle")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("connectedDescription")}
              </p>
            </div>
          )}
          {status === CONNECT_STATUS.FAILED && (
            <div className="space-y-2">
              <h1 className="text-xl font-semibold">
                {requiresExtensionUpdate
                  ? t("connectFailedTitle")
                  : requiresReauth
                    ? t("connectReauthTitle")
                    : requiresRecentSession
                      ? t("connectRecentSessionTitle")
                      : t("connectFailedTitle")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {requiresExtensionUpdate
                  ? t("extensionRequired")
                  : requiresReauth
                    ? t("connectReauthDescription")
                    : requiresRecentSession
                      ? t("connectRecentSessionDescription")
                      : t("connectFailedDescription")}
              </p>
              {reauthError ? (
                <p className="text-sm text-destructive">{reauthError}</p>
              ) : null}
            </div>
          )}

          {/* Actions */}
          {status === CONNECT_STATUS.AWAITING_CLICK && (
            <div className="flex flex-col gap-3 w-full max-w-xs">
              <Button onClick={handleConnectClick} className="w-full">
                {t("connect")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setStatus(CONNECT_STATUS.IDLE)}
                className="w-full"
              >
                {t("goToDashboard")}
              </Button>
            </div>
          )}
          {status === CONNECT_STATUS.CONNECTED && (
            <div className="flex flex-col gap-3 w-full max-w-xs">
              <Button
                onClick={() => setStatus(CONNECT_STATUS.IDLE)}
                className="w-full"
              >
                {t("goToDashboard")}
              </Button>
            </div>
          )}
          {status === CONNECT_STATUS.FAILED && (
            <div className="flex flex-col gap-3 w-full max-w-xs">
              {requiresExtensionUpdate ? (
                <Button
                  asChild
                  className="w-full"
                >
                  <a
                    href="https://chrome.google.com/webstore"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("extensionRequiredAction")}
                  </a>
                </Button>
              ) : (
                <Button
                  onClick={handleRetry}
                  className="w-full"
                  disabled={reauthenticating}
                >
                  {reauthenticating ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t("connecting")}
                    </>
                  ) : requiresReauth ? (
                    t("connectReauthAction")
                  ) : requiresRecentSession ? (
                    t("connectRecentSessionAction")
                  ) : (
                    t("retry")
                  )}
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => setStatus(CONNECT_STATUS.IDLE)}
                className="w-full"
              >
                {t("goToDashboard")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
