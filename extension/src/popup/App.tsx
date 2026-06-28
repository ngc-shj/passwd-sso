import { useCallback, useEffect, useState } from "react";
import { sendMessage } from "../lib/messaging";
import { SESSION_KEY, PSSO_VAULT_STATE_CHANGED } from "../lib/constants";
import { t } from "../lib/i18n";
import { LoginPrompt } from "./components/LoginPrompt";
import { VaultUnlock } from "./components/VaultUnlock";
import { MatchList } from "./components/MatchList";
import { DISCONNECT_REASON, type DisconnectReason } from "../lib/disconnect-reason";

type AppState = "loading" | "error" | "not_logged_in" | "logged_in" | "vault_unlocked";

// MV3 service workers can be torn down between popup opens; the first
// GET_STATUS may reject ("message channel closed") or hang while the SW wakes
// and rehydrates. Guard with a timeout + a few retries so the popup never
// strands on the loading spinner.
const STATUS_TIMEOUT_MS = 3000;
const MAX_STATUS_RETRIES = 2;
const STATUS_RETRY_DELAY_MS = 250;

function fetchStatus() {
  const status = sendMessage({ type: "GET_STATUS" });
  // If the timeout wins the race, the SW reply may still reject later
  // ("message channel closed"). Attach a no-op handler so that late rejection
  // does not surface as an unhandledrejection.
  status.catch(() => {});
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("GET_STATUS timeout")), STATUS_TIMEOUT_MS);
  });
  return Promise.race([status, timeout]).finally(() => clearTimeout(timer));
}

async function notifyVaultStateChanged(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: PSSO_VAULT_STATE_CHANGED });
    }
  } catch {
    // content script may not be present on this tab
  }
}

export function App() {
  const [state, setState] = useState<AppState>("loading");
  const [tabUrl, setTabUrl] = useState<string | null>(null);
  const [disconnectReason, setDisconnectReason] = useState<DisconnectReason | null>(null);
  const containerMinHeight =
    state === "vault_unlocked" ? "min-h-[480px]" : "min-h-[260px]";

  // allowError=false is used by background refreshes (storage events): a
  // transient failure there must leave the current view intact rather than
  // clobbering a working screen with the error pane.
  const refreshStatus = useCallback((attempt = 0, allowError = true) => {
    fetchStatus()
      .then((res) => {
        if (!res.hasToken) {
          setDisconnectReason(res.disconnectReason ?? null);
          setState("not_logged_in");
        } else if (res.vaultUnlocked) {
          setState("vault_unlocked");
        } else {
          setState("logged_in");
        }
      })
      .catch(() => {
        if (attempt < MAX_STATUS_RETRIES) {
          setTimeout(() => refreshStatus(attempt + 1, allowError), STATUS_RETRY_DELAY_MS);
        } else if (allowError) {
          // Surface a manual retry instead of spinning forever.
          setState("error");
        }
      });
  }, []);

  useEffect(() => {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        setTabUrl(tabs[0]?.url ?? null);
      })
      .catch(() => {
        setTabUrl(null);
      });
    refreshStatus();
  }, [refreshStatus]);

  // Re-check status when vault state changes externally (e.g. keyboard shortcut lock)
  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName === "session" && SESSION_KEY in changes) {
        refreshStatus(0, false);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [refreshStatus]);

  const handleLock = async () => {
    // Locking is fail-secure: a torn-down SW has already lost the in-memory
    // key, so reflect the locked state locally even if the message rejects.
    try {
      await sendMessage({ type: "LOCK_VAULT" });
    } catch {
      // SW unreachable — treat as locked.
    }
    setState("logged_in");
  };

  const handleDisconnect = async () => {
    // CLEAR_TOKEN revokes the token server-side; if it never reached the SW,
    // do NOT claim "disconnected" — surface the error so the user can retry.
    try {
      await sendMessage({ type: "CLEAR_TOKEN" });
    } catch {
      setState("error");
      return;
    }
    // Manual disconnect → generic prompt, no "session expired" framing.
    setDisconnectReason(DISCONNECT_REASON.MANUAL);
    setState("not_logged_in");
  };

  return (
    <div className={`flex flex-col ${containerMinHeight} bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100`}>
      <header className="flex items-center justify-between gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700">
        <h1 className="text-base font-semibold">{t("popup.title")}</h1>
        <div className="flex items-center gap-1">
          {state === "vault_unlocked" && (
            <button
              type="button"
              onClick={handleLock}
              title={t("popup.lock")}
              className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </button>
          )}
          {(state === "logged_in" || state === "vault_unlocked") && (
            <button
              type="button"
              onClick={handleDisconnect}
              title={t("popup.disconnect")}
              className="p-1.5 rounded-md text-gray-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/></svg>
            </button>
          )}
          <button
            onClick={() => chrome.runtime.openOptionsPage()}
            title={t("popup.settings")}
            aria-label={t("popup.settings")}
            className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
        </div>
      </header>

      <main className="flex-1 px-3 py-2">
        {state === "loading" && (
          <div className="flex items-center justify-center h-full">
            <p className="text-gray-500">{t("popup.loading")}</p>
          </div>
        )}
        {state === "error" && (
          <div className="flex flex-col items-center justify-center gap-3 h-full text-center">
            <p className="text-sm text-gray-500">{t("popup.statusError")}</p>
            <button
              type="button"
              onClick={() => {
                setState("loading");
                refreshStatus();
              }}
              className="px-3 py-1.5 text-sm rounded-md bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              {t("popup.retry")}
            </button>
          </div>
        )}
        {state === "not_logged_in" && <LoginPrompt reason={disconnectReason} />}
        {state === "logged_in" && (
          <VaultUnlock
            onUnlocked={() => {
              setState("vault_unlocked");
              notifyVaultStateChanged();
            }}
            tabUrl={tabUrl}
          />
        )}
        {state === "vault_unlocked" && (
          <MatchList tabUrl={tabUrl} />
        )}
      </main>
    </div>
  );
}
