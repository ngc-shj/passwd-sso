"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { injectExtensionToken } from "@/lib/inject-extension-token";

/**
 * Automatically connects the browser extension after vault unlock
 * when the page was opened from the extension (indicated by ?ext_connect=1).
 *
 * Rendered inside VaultGate only when vault is unlocked.
 */
export function AutoExtensionConnect() {
  const t = useTranslations("Extension");
  const didRunRef = useRef(false);

  useEffect(() => {
    if (didRunRef.current) return;

    const params = new URLSearchParams(window.location.search);
    if (!params.has("ext_connect")) return;

    didRunRef.current = true;

    // Remove ext_connect from URL immediately to prevent re-fire on reload
    params.delete("ext_connect");
    const newSearch = params.toString();
    const newUrl =
      window.location.pathname + (newSearch ? `?${newSearch}` : "") + window.location.hash;
    window.history.replaceState(null, "", newUrl);

    // Generate token and inject into DOM for the token-bridge content script
    (async () => {
      try {
        const res = await fetch("/api/extension/token", { method: "POST" });
        if (!res.ok) {
          toast.error(t("autoConnectFailed"));
          return;
        }
        const json = await res.json();
        injectExtensionToken(json.token, Date.parse(json.expiresAt));
        toast.success(t("autoConnected"));
      } catch {
        toast.error(t("autoConnectFailed"));
      }
    })();
  }, [t]);

  return null;
}
