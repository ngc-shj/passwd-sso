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
import { abortInFlightCeremony } from "@/lib/auth/webauthn/webauthn-client";
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
interface AutoExtensionConnectProps {
  /**
   * Notifies the parent whether the connect overlay is currently showing
   * (any non-IDLE state). Lets the VaultGate keep showing the overlay ahead of
   * the vault lock screen while connecting, then fall back to the normal gate
   * once the flow goes idle (user dismissed / went to dashboard).
   */
  onActiveChange?: (active: boolean) => void;
}

export function AutoExtensionConnect({ onActiveChange }: AutoExtensionConnectProps = {}) {
  const t = useTranslations("Extension");
  const locale = useLocale();
  const didRunRef = useRef(false);
  const [status, setStatus] = useState<ConnectStatus>(CONNECT_STATUS.IDLE);
  const [requiresReauth, setRequiresReauth] = useState(false);
  const [requiresRecentSession, setRequiresRecentSession] = useState(false);
  const [requiresExtensionUpdate, setRequiresExtensionUpdate] = useState(false);
  const [requiresPasskeyRegistration, setRequiresPasskeyRegistration] = useState(false);
  const [reauthenticating, setReauthenticating] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);
  // True once a passkey reauth succeeded and we bounced back to AWAITING_CLICK
  // for the activation-consuming second click. Reframes that card as a
  // continuation ("Re-authentication complete / Finish connecting") so the
  // second Allow does not read as a duplicate of the first.
  const [cameFromReauth, setCameFromReauth] = useState(false);

  const connect = useCallback(async (): Promise<{ ok: boolean; requiresReauth: boolean }> => {
    setStatus(CONNECT_STATUS.CONNECTING);
    setRequiresReauth(false);
    setRequiresRecentSession(false);
    setRequiresExtensionUpdate(false);
    setRequiresPasskeyRegistration(false);
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

      if (result.errorCode === EXTENSION_CONNECT_ERROR_CODE.PASSKEY_REQUIRED) {
        setRequiresPasskeyRegistration(true);
        setStatus(CONNECT_STATUS.FAILED);
        return { ok: false, requiresReauth: false };
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

    // C15-v2: surface the AWAITING_CLICK confirmation card instead of auto-
    // firing connect(). The user click on the Allow button satisfies
    // navigator.userActivation.isActive at the moment of postMessage; the
    // content-script gate then refuses XSS-issued postMessages that arrive
    // without that activation. URL param removal is deferred to the click
    // handler so reload reproduces the prompt.
    setStatus(CONNECT_STATUS.AWAITING_CLICK);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Report active/idle to the parent gate so it can defer the vault lock screen
  // while the connect overlay is showing. Suppress the initial IDLE report: on a
  // fresh ext_connect mount the status is briefly IDLE before the mount effect
  // sets AWAITING_CLICK; reporting that transient IDLE would make the gate tear
  // the overlay down before it ever shows. Only report idle AFTER we've gone
  // active at least once (the genuine dismissal/done transition).
  const wasActiveRef = useRef(false);
  useEffect(() => {
    const active = status !== CONNECT_STATUS.IDLE;
    if (active) {
      wasActiveRef.current = true;
      onActiveChange?.(true);
    } else if (wasActiveRef.current) {
      onActiveChange?.(false);
    }
  }, [status, onActiveChange]);

  const handleConnectClick = useCallback(async () => {
    const params = new URLSearchParams(window.location.search);
    params.delete(EXT_CONNECT_PARAM);
    const newSearch = params.toString();
    const newUrl =
      window.location.pathname + (newSearch ? `?${newSearch}` : "") + window.location.hash;
    window.history.replaceState(null, "", newUrl);

    await connect();
  }, [connect]);

  // Sign out and bounce to the full sign-in page, preserving ext_connect so the
  // extension connection resumes after a fresh sign-in. Used both when the user
  // has no passkey (recent-session path) and when the web session has fully
  // expired (reauth options returns 401) — passkey reauth can never succeed
  // without a session, so looping on the prompt would strand the user.
  const redirectToFullSignIn = useCallback(async () => {
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set(EXT_CONNECT_PARAM, "1");
    const callbackUrl = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
    const signInPath = `${withBasePath(`/${locale}/auth/signin`)}?callbackUrl=${encodeURIComponent(callbackUrl)}`;
    await signOut({ callbackUrl: signInPath });
  }, [locale]);

  // Abort the in-flight passkey ceremony so the user can escape a stuck
  // "verifying" state. reauthenticateWithPasskey then resolves to
  // AUTHENTICATION_CANCELLED, which handleRetry surfaces as a retry prompt.
  const handleCancelReauth = () => {
    abortInFlightCeremony();
  };

  const handleRetry = async () => {
    if (!requiresReauth) {
      if (requiresRecentSession) {
        setReauthenticating(true);
        try {
          await redirectToFullSignIn();
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
        // Session fully expired (not merely stale): reauth options 401'd, so a
        // passkey ceremony can never complete. Route to a full sign-in instead
        // of leaving the user clicking the passkey button forever.
        if (result.error === "UNAUTHORIZED") {
          await redirectToFullSignIn();
          return;
        }
        setReauthError(
          result.error === "AUTHENTICATION_CANCELLED"
            ? t("connectReauthCancelled")
            : t("connectReauthFailed"),
        );
        return;
      }

      // C15-v2: navigator.credentials.get() inside reauthenticateWithPasskey
      // CONSUMES the page's transient user activation per HTML User
      // Activation v2. A subsequent connect() → postMessage would be silent-
      // dropped by the content-script gate. Surface AWAITING_CLICK so the
      // user provides a fresh gesture to authorize the now-step-up'd
      // connection. The card is reframed via cameFromReauth as a continuation
      // ("Re-authentication complete / Finish connecting") so the second Allow
      // click reads as finishing the connection, not repeating the first.
      setCameFromReauth(true);
      setStatus(CONNECT_STATUS.AWAITING_CLICK);
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
              <h1 className="text-xl font-semibold">
                {cameFromReauth
                  ? t("continueAfterReauthTitle")
                  : t("awaitingClickTitle")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {cameFromReauth
                  ? t("continueAfterReauthDescription")
                  : t("awaitingClickDescription")}
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
                      : requiresPasskeyRegistration
                        ? t("connectPasskeyRequiredTitle")
                        : t("connectFailedTitle")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {requiresExtensionUpdate
                  ? t("extensionRequired")
                  : requiresReauth
                    ? t("connectReauthDescription")
                    : requiresRecentSession
                      ? t("connectRecentSessionDescription")
                      : requiresPasskeyRegistration
                        ? t("connectPasskeyRequiredDescription")
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
              <Button
                onClick={handleConnectClick}
                className="w-full"
                data-c15-action="allow-connect"
              >
                {cameFromReauth
                  ? t("continueAfterReauthAction")
                  : t("awaitingClickAction")}
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
                      {requiresReauth ? t("connectReauthVerifying") : t("connecting")}
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
              {reauthenticating && requiresReauth ? (
                <Button
                  variant="ghost"
                  onClick={handleCancelReauth}
                  className="w-full"
                >
                  {t("connectReauthCancel")}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => setStatus(CONNECT_STATUS.IDLE)}
                  className="w-full"
                >
                  {t("goToDashboard")}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
