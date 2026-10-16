import { useCallback, useEffect, useRef, useState } from "react";
import { sendMessage } from "../lib/messaging";
import { t } from "../lib/i18n";
import { EXT_MSG } from "../lib/constants";
import type { HttpAuthDecision, HttpAuthPromptView } from "../types/messages";

/**
 * Send stays disabled this long after the window is visible and focused, and
 * again after every refocus, so a click or key aimed at the page the window
 * popped over cannot land on it.
 */
export const SEND_ARM_DELAY_MS = 800;

// The HTTP auth confirmation window (#905). Shows what the challenge is and
// which login would answer it; never the server's realm text. Only an
// unhurried click on Send while this window has focus releases the login.
// Enter and Escape mean Cancel, and Send is never the default or focused button.
export function App({ promptId }: { promptId: string | null }) {
  // undefined: loading; null: unknown or no longer pending.
  const [view, setView] = useState<HttpAuthPromptView | null | undefined>(undefined);
  const [armed, setArmed] = useState(false);
  const decided = useRef(false);

  useEffect(() => {
    if (!promptId) {
      setView(null);
      return;
    }
    sendMessage({ type: EXT_MSG.HTTP_AUTH_PROMPT_GET, promptId })
      .then((res) => setView(res?.prompt ?? null))
      .catch(() => setView(null));
  }, [promptId]);

  const decide = useCallback(
    (decision: HttpAuthDecision) => {
      if (decided.current || !promptId) return;
      decided.current = true;
      setArmed(false);
      sendMessage({ type: EXT_MSG.HTTP_AUTH_PROMPT_DECIDE, promptId, decision })
        .catch(() => {})
        .finally(() => window.close());
    },
    [promptId],
  );

  const ready = view !== undefined && view !== null;

  // Arm Send only while the window is visible and focused, after the delay.
  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disarm = () => {
      clearTimeout(timer);
      timer = undefined;
      setArmed(false);
    };
    const rearm = () => {
      disarm();
      if (document.visibilityState === "visible" && document.hasFocus()) {
        timer = setTimeout(() => setArmed(true), SEND_ARM_DELAY_MS);
      }
    };
    rearm();
    window.addEventListener("focus", rearm);
    window.addEventListener("blur", disarm);
    document.addEventListener("visibilitychange", rearm);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", rearm);
      window.removeEventListener("blur", disarm);
      document.removeEventListener("visibilitychange", rearm);
    };
  }, [ready]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      decide("cancel");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [decide]);

  const onSend = () => {
    if (!armed || !document.hasFocus()) return;
    decide("send");
  };

  if (view === undefined) {
    return <p className="p-4 text-sm text-gray-500 dark:text-gray-400">{t("authPrompt.loading")}</p>;
  }

  if (view === null) {
    return (
      <div className="p-4 flex flex-col gap-3">
        <p className="text-sm text-gray-700 dark:text-gray-200">{t("authPrompt.expired")}</p>
        <button
          type="button"
          onClick={() => window.close()}
          className="h-9 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600"
        >
          {t("authPrompt.close")}
        </button>
      </div>
    );
  }

  const rows: Array<[string, string]> = [
    [t("authPrompt.site"), view.origin],
    [t("authPrompt.address"), view.url],
    [t("authPrompt.triggeredBy"), view.initiator ?? t("authPrompt.addressBar")],
    [t("authPrompt.login"), view.entryUsername ? `${view.entryTitle} (${view.entryUsername})` : view.entryTitle],
    [t("authPrompt.method"), view.scheme === "digest" ? "Digest" : "Basic"],
  ];

  return (
    <div className="p-4 flex flex-col gap-3 text-gray-900 dark:text-gray-100">
      <h1 className="text-sm font-semibold">{t("authPrompt.heading")}</h1>
      <dl className="flex flex-col gap-1.5 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
      {view.insecure && (
        <p
          role="alert"
          className="text-xs text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-md px-2 py-1.5"
        >
          <span aria-hidden="true">⚠ </span>
          {t("authPrompt.httpWarning")}
        </p>
      )}
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={() => decide("cancel")}
          className="h-9 px-4 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600"
        >
          {t("authPrompt.cancel")}
        </button>
        <button
          type="button"
          onClick={onSend}
          disabled={!armed}
          className="h-9 px-4 rounded-md text-sm font-medium text-white bg-gray-900 dark:bg-gray-200 dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t("authPrompt.send")}
        </button>
      </div>
    </div>
  );
}
