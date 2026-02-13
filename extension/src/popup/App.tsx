import { useEffect, useState } from "react";
import { sendMessage } from "../lib/messaging";
import { t } from "../lib/i18n";
import { LoginPrompt } from "./components/LoginPrompt";
import { VaultUnlock } from "./components/VaultUnlock";
import { MatchList } from "./components/MatchList";

type AppState = "loading" | "not_logged_in" | "logged_in" | "vault_unlocked";

async function checkHostPermission(url: string): Promise<boolean> {
  try {
    const origin = new URL(url).origin;
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return true; // non-http URLs — don't show button
  }
}

export function App() {
  const [state, setState] = useState<AppState>("loading");
  const [tabUrl, setTabUrl] = useState<string | null>(null);
  const [hasHostPermission, setHasHostPermission] = useState(true);

  useEffect(() => {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        const url = tabs[0]?.url ?? null;
        setTabUrl(url);
        if (url) {
          checkHostPermission(url).then(setHasHostPermission).catch(() => {});
        }
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
      <header className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-200">
        <h1 className="text-lg font-semibold">{t("popup.title")}</h1>
        <button
          onClick={() => chrome.runtime.openOptionsPage()}
          className="text-gray-500 hover:text-gray-700 text-3xl leading-none w-10 h-10 flex items-center justify-center"
          title={t("popup.settings")}
          aria-label={t("popup.settings")}
        >
          ⚙
        </button>
      </header>

      <main className="flex-1 p-4">
        {state === "loading" && (
          <div className="flex items-center justify-center h-full">
            <p className="text-gray-500">{t("popup.loading")}</p>
          </div>
        )}
        {state === "not_logged_in" && <LoginPrompt />}
        {state === "logged_in" && (
          <VaultUnlock onUnlocked={() => setState("vault_unlocked")} />
        )}
        {state === "vault_unlocked" && (
          <>
            {!hasHostPermission && tabUrl && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    const origin = new URL(tabUrl).origin;
                    const granted = await chrome.permissions.request({
                      origins: [`${origin}/*`],
                    });
                    if (granted) setHasHostPermission(true);
                  } catch {
                    // ignore
                  }
                }}
                className="mb-3 w-full px-3 py-2 text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 transition-colors"
              >
                {t("popup.enableAutofill")}
              </button>
            )}
            <MatchList tabUrl={tabUrl} onLock={() => setState("logged_in")} />
          </>
        )}
      </main>
    </div>
  );
}
