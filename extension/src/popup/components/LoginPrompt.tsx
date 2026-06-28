import { useEffect, useState } from "react";
import { getSettings } from "../../lib/storage";
import { t } from "../../lib/i18n";
import { EXT_CONNECT_PARAM } from "../../lib/constants";
import { DISCONNECT_REASON, type DisconnectReason } from "../../lib/disconnect-reason";

interface LoginPromptProps {
  /** Why the previous connection ended; drives the context line. */
  reason?: DisconnectReason | null;
}

/** Map a disconnect reason to the context-line message key, or null for the generic prompt. */
function reasonMessageKey(reason: DisconnectReason | null | undefined): string | null {
  switch (reason) {
    case DISCONNECT_REASON.EXPIRED:
    case DISCONNECT_REASON.TIMEOUT_LOGOUT:
      return "popup.disconnectedExpired";
    case DISCONNECT_REASON.REVOKED:
      return "popup.disconnectedRevoked";
    default:
      // MANUAL or no recorded reason — generic prompt, no forewarning.
      return null;
  }
}

export function LoginPrompt({ reason }: LoginPromptProps) {
  const [serverUrl, setServerUrl] = useState("");

  useEffect(() => {
    getSettings().then((s) => setServerUrl(s.serverUrl));
  }, []);

  const handleLogin = () => {
    if (!serverUrl) return;
    chrome.tabs.create({ url: `${serverUrl}/dashboard?${EXT_CONNECT_PARAM}=1` });
  };

  const contextKey = reasonMessageKey(reason);

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-8">
      {contextKey ? (
        <div className="flex flex-col gap-1 text-center">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t(contextKey)}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t("popup.reauthHint")}
          </p>
        </div>
      ) : (
        <p className="text-sm text-gray-600 dark:text-gray-400 text-center">
          {t("popup.signIn")}
        </p>
      )}
      {serverUrl && (
        <p className="text-xs text-gray-500 dark:text-gray-400 break-all text-center">
          {serverUrl}
        </p>
      )}
      <button
        onClick={handleLogin}
        className="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-md hover:bg-gray-800 dark:hover:bg-gray-200 active:bg-gray-950 transition-colors"
      >
        {t("popup.openApp")}
      </button>
    </div>
  );
}
