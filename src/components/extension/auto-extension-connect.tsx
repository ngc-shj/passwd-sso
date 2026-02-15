"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { injectExtensionToken } from "@/lib/inject-extension-token";
import {
  API_PATH,
  EXT_CONNECT_PARAM,
  CONNECT_STATUS,
  type ConnectStatus,
} from "@/lib/constants";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, Loader2, KeyRound } from "lucide-react";

const SKIP_BEFOREUNLOAD_ONCE_KEY = "psso:skip-beforeunload-once";
const ALLOW_BEFOREUNLOAD_WHILE_CONNECTED_KEY =
  "psso:allow-beforeunload-while-ext-connect";

/**
 * Automatically connects the browser extension after vault unlock
 * when the page was opened from the extension (indicated by ?ext_connect=1).
 *
 * Shows a full-page connection status UI instead of the dashboard.
 */
export function AutoExtensionConnect() {
  const t = useTranslations("Extension");
  const didRunRef = useRef(false);
  const [status, setStatus] = useState<ConnectStatus>(CONNECT_STATUS.IDLE);

  const connect = async () => {
    setStatus(CONNECT_STATUS.CONNECTING);
    try {
      const res = await fetch(API_PATH.EXTENSION_TOKEN, { method: "POST" });
      if (!res.ok) {
        setStatus(CONNECT_STATUS.FAILED);
        return;
      }
      const json = await res.json();
      injectExtensionToken(json.token, Date.parse(json.expiresAt));
      setStatus(CONNECT_STATUS.CONNECTED);
    } catch {
      setStatus(CONNECT_STATUS.FAILED);
    }
  };

  useEffect(() => {
    if (didRunRef.current) return;

    const params = new URLSearchParams(window.location.search);
    if (!params.has(EXT_CONNECT_PARAM)) return;

    didRunRef.current = true;

    // Remove ext_connect from URL immediately to prevent re-fire on reload
    params.delete(EXT_CONNECT_PARAM);
    const newSearch = params.toString();
    const newUrl =
      window.location.pathname + (newSearch ? `?${newSearch}` : "") + window.location.hash;
    window.history.replaceState(null, "", newUrl);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    connect();
  }, []);

  const handleRetry = () => {
    connect();
  };

  const handleCloseTab = () => {
    try {
      sessionStorage.setItem(SKIP_BEFOREUNLOAD_ONCE_KEY, "1");
    } catch {
      // ignore storage failures; close will still be attempted
    }
    window.close();
  };

  useEffect(() => {
    try {
      if (status === CONNECT_STATUS.CONNECTED) {
        sessionStorage.setItem(ALLOW_BEFOREUNLOAD_WHILE_CONNECTED_KEY, "1");
      } else {
        sessionStorage.removeItem(ALLOW_BEFOREUNLOAD_WHILE_CONNECTED_KEY);
      }
    } catch {
      // ignore storage failures
    }
  }, [status]);

  // No ext_connect param — render nothing, let dashboard show
  if (status === CONNECT_STATUS.IDLE) return null;

  return (
    <div className="fixed inset-0 z-50 flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center text-center pt-8 pb-8 space-y-6">
          {/* Icon */}
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
            <span className="text-sm font-medium">passwd-sso</span>
          </div>

          {/* Title & Description */}
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
              <h1 className="text-xl font-semibold">{t("connectFailedTitle")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("connectFailedDescription")}
              </p>
            </div>
          )}

          {/* Actions */}
          {status === CONNECT_STATUS.CONNECTED && (
            <div className="flex flex-col gap-3 w-full max-w-xs">
              <Button
                onClick={handleCloseTab}
                className="w-full"
              >
                {t("closeTab")}
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
          {status === CONNECT_STATUS.FAILED && (
            <div className="flex flex-col gap-3 w-full max-w-xs">
              <Button
                onClick={handleRetry}
                className="w-full"
              >
                {t("retry")}
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
        </CardContent>
      </Card>
    </div>
  );
}
