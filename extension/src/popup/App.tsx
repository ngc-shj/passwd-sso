import { useCallback, useEffect, useState } from "react";
import { sendMessage } from "../lib/messaging";
import { SESSION_KEY } from "../lib/constants";
import { t } from "../lib/i18n";
import { LoginPrompt } from "./components/LoginPrompt";
import { VaultUnlock } from "./components/VaultUnlock";
import { MatchList } from "./components/MatchList";

type AppState = "loading" | "not_logged_in" | "logged_in" | "vault_unlocked";

async function notifyVaultStateChanged(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: "PSSO_VAULT_STATE_CHANGED" });
    }
  } catch {
    // content script may not be present on this tab
  }
}

export function App() {
  const [state, setState] = useState<AppState>("loading");
  const [tabUrl, setTabUrl] = useState<string | null>(null);
  const containerMinHeight =
    state === "vault_unlocked" ? "min-h-[480px]" : "min-h-[260px]";

  const refreshStatus = useCallback(() => {
    sendMessage({ type: "GET_STATUS" }).then((res) => {
      if (!res.hasToken) {
        setState("not_logged_in");
      } else if (res.vaultUnlocked) {
        setState("vault_unlocked");
      } else {
        setState("logged_in");
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
        refreshStatus();
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [refreshStatus]);

  const handleLock = async () => {
    await sendMessage({ type: "LOCK_VAULT" });
    setState("logged_in");
  };

  const handleDisconnect = async () => {
    await sendMessage({ type: "CLEAR_TOKEN" });
    setState("not_logged_in");
  };

  return (
    <div className={`flex flex-col ${containerMinHeight} bg-white text-gray-900`}>
      <header className="flex items-center justify-between gap-2 px-4 py-2 border-b border-gray-200">
        <h1 className="text-base font-semibold">{t("popup.title")}</h1>
        <div className="flex items-center gap-1">
          {state === "vault_unlocked" && (
            <button
              type="button"
              onClick={handleLock}
              title={t("popup.lock")}
              className="p-1.5 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </button>
          )}
          {(state === "logged_in" || state === "vault_unlocked") && (
            <button
              type="button"
              onClick={handleDisconnect}
              title={t("popup.disconnect")}
              className="p-1.5 rounded-md text-gray-500 hover:text-red-600 hover:bg-red-50 transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </button>
          )}
          <button
            onClick={() => chrome.runtime.openOptionsPage()}
            title={t("popup.settings")}
            aria-label={t("popup.settings")}
            className="p-1.5 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
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
        {state === "not_logged_in" && <LoginPrompt />}
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
