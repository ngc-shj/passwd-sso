import { useEffect, useState } from "react";
import { sendMessage } from "../lib/messaging";
import { LoginPrompt } from "./components/LoginPrompt";
import { VaultUnlock } from "./components/VaultUnlock";
import { MatchList } from "./components/MatchList";

type AppState = "loading" | "not_logged_in" | "logged_in" | "vault_unlocked";

export function App() {
  const [state, setState] = useState<AppState>("loading");

  useEffect(() => {
    sendMessage({ type: "GET_STATUS" }).then((res) => {
      if (res.hasToken) {
        // Token exists — vault unlock flow is next phase
        setState("logged_in");
      } else {
        setState("not_logged_in");
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
        {state === "logged_in" && <VaultUnlock />}
        {state === "vault_unlocked" && <MatchList />}
      </main>
    </div>
  );
}
