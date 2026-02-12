import { useEffect, useState } from "react";
import { sendMessage } from "../lib/messaging";
import { LoginPrompt } from "./components/LoginPrompt";
import { VaultUnlock } from "./components/VaultUnlock";
import { MatchList } from "./components/MatchList";

type AppState = "loading" | "not_logged_in" | "logged_in" | "vault_unlocked";

export function App() {
  const [state, setState] = useState<AppState>("loading");
  const [tabUrl, setTabUrl] = useState<string | null>(null);

  useEffect(() => {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        setTabUrl(tabs[0]?.url ?? null);
      })
      .catch(() => {
        setTabUrl(null);
      });
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

  return (
    <div className="flex flex-col min-h-[480px] bg-white text-gray-900">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
        <h1 className="text-lg font-semibold">passwd-sso</h1>
      </header>

      <main className="flex-1 p-4">
        {state === "loading" && (
          <div className="flex items-center justify-center h-full">
            <p className="text-gray-500">Loading...</p>
          </div>
        )}
        {state === "not_logged_in" && <LoginPrompt />}
        {state === "logged_in" && (
          <VaultUnlock onUnlocked={() => setState("vault_unlocked")} />
        )}
        {state === "vault_unlocked" && (
          <MatchList tabUrl={tabUrl} onLock={() => setState("logged_in")} />
        )}
      </main>
    </div>
  );
}
