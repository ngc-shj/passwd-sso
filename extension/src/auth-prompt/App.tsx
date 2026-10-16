import { useCallback, useEffect, useRef, useState } from "react";
import { sendMessage } from "../lib/messaging";
import { t } from "../lib/i18n";
import { EXT_MSG, HTTP_AUTH_PROMPT_TIMEOUT_MS } from "../lib/constants";
import type { HttpAuthDecision, HttpAuthPromptView } from "../types/messages";

/**
 * Send stays disabled this long after the window is visible and focused, after
 * every refocus, and again after any press (pointer or key) made while it is
 * disabled, so a click train or key repeat aimed at the page the window popped
 * over cannot run into it.
 */
export const SEND_ARM_DELAY_MS = 800;

/** Longest address shown; the origin is always shown whole. */
export const URL_DISPLAY_MAX = 120;

/** `url` for display: the origin whole, the rest cut to fit with an ellipsis. */
export function displayUrl(url: string, max = URL_DISPLAY_MAX): string {
  if (url.length <= max) return url;
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    return `${url.slice(0, max - 1)}…`;
  }
  const rest = url.slice(origin.length);
  // Nothing after the origin to cut: an origin is never shortened, since
  // cutting a host would hide its registrable domain.
  if (rest === "") return url;
  const room = Math.max(0, max - origin.length - 1);
  return `${origin}${rest.slice(0, room)}…`;
}

// The HTTP auth confirmation window (#905). Shows what the challenge is and
// which login would answer it; never the server's realm text. A pointer click
// releases the login only when the pointer moved onto Send after Send was
// armed and the press began there while armed, so a stationary click train
// at Send's position never completes, however slow. The keyboard (Tab to Send,
// which restarts the delay, then Space) and assistive technology use clicks
// with no pointer behind them. Enter and Escape mean Cancel, and Send is never
// the default or focused button.
export function App({ promptId }: { promptId: string | null }) {
  // undefined: loading; null: unknown or no longer pending.
  const [view, setView] = useState<HttpAuthPromptView | null | undefined>(undefined);
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  // Whether the pointer press now ending on Send began while Send was armed.
  const pressBeganArmed = useRef(false);
  // Set by a pointerdown on Send, so the focus that press gives Send is not
  // taken for keyboard focus.
  const focusFromPointer = useRef(false);
  const rearmRef = useRef<() => void>(() => {});
  const decided = useRef(false);
  // Whether the pointer moved onto Send (from outside it) since Send was armed.
  const [entered, setEntered] = useState(false);
  const enteredRef = useRef(false);
  // Whether the window is visible and focused (only then can Send arm).
  const [windowActive, setWindowActive] = useState(false);
  // Whether Send holds keyboard focus (Tab), which needs no pointer.
  const [keyboardOnSend, setKeyboardOnSend] = useState(false);
  const sendRef = useRef<HTMLButtonElement | null>(null);

  const setEnteredBoth = (value: boolean) => {
    enteredRef.current = value;
    setEntered(value);
  };

  const setArmedBoth = (value: boolean) => {
    armedRef.current = value;
    setArmed(value);
    // Arming starts a new wait for the pointer to arrive; a pointer already
    // resting on Send does not count.
    setEnteredBoth(false);
  };

  useEffect(() => {
    if (!promptId) {
      setView(null);
      return;
    }
    sendMessage({ type: EXT_MSG.HTTP_AUTH_PROMPT_GET, promptId })
      .then((res) => setView(res?.prompt ?? null))
      .catch(() => setView(null));
  }, [promptId]);

  // A window left open outlives its challenge; the SW closes it on every
  // outcome, and this is the backstop for a SW that is gone.
  useEffect(() => {
    const timer = setTimeout(() => window.close(), HTTP_AUTH_PROMPT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  const decide = useCallback(
    (decision: HttpAuthDecision) => {
      if (decided.current || !promptId) return;
      decided.current = true;
      setArmedBoth(false);
      sendMessage({ type: EXT_MSG.HTTP_AUTH_PROMPT_DECIDE, promptId, decision })
        .catch(() => {})
        .finally(() => window.close());
    },
    [promptId],
  );

  const ready = view !== undefined && view !== null;

  // Arm Send only while the window is visible and focused, after the delay;
  // any press while disarmed starts the delay over.
  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disarm = () => {
      clearTimeout(timer);
      timer = undefined;
      pressBeganArmed.current = false;
      setArmedBoth(false);
    };
    const rearm = () => {
      disarm();
      const active = document.visibilityState === "visible" && document.hasFocus();
      setWindowActive(active);
      if (active) {
        timer = setTimeout(() => setArmedBoth(true), SEND_ARM_DELAY_MS);
      }
    };
    const onBlur = () => {
      disarm();
      setWindowActive(false);
    };
    const onPress = () => {
      if (!armedRef.current) rearm();
    };
    rearmRef.current = rearm;
    rearm();
    window.addEventListener("focus", rearm);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", rearm);
    window.addEventListener("pointerdown", onPress, true);
    window.addEventListener("keydown", onPress, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", rearm);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", rearm);
      window.removeEventListener("pointerdown", onPress, true);
      window.removeEventListener("keydown", onPress, true);
      rearmRef.current = () => {};
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

  // The pointer moving onto Send from outside it (pointerenter does not fire
  // for a pointer that was already there).
  useEffect(() => {
    const button = sendRef.current;
    if (!ready || !button) return;
    const onEnter = () => {
      if (armedRef.current) setEnteredBoth(true);
    };
    button.addEventListener("pointerenter", onEnter);
    return () => button.removeEventListener("pointerenter", onEnter);
  }, [ready]);

  const onSendPointerDown = () => {
    pressBeganArmed.current = armedRef.current;
    focusFromPointer.current = true;
  };

  // Keyboard focus reaching Send (Tab) starts the delay over, so Tab then
  // Space cannot run together.
  const onSendFocus = () => {
    if (focusFromPointer.current) {
      focusFromPointer.current = false;
      return;
    }
    setKeyboardOnSend(true);
    rearmRef.current();
  };

  const onSend = (e: React.MouseEvent<HTMLButtonElement>) => {
    const began = pressBeganArmed.current;
    pressBeganArmed.current = false;
    if (!armedRef.current || !document.hasFocus()) return;
    // A click from a pointer has a detail (click count) or a pointerType; one
    // with neither is Space on the focused button or assistive technology.
    const pointerType = (e.nativeEvent as MouseEvent & { pointerType?: unknown }).pointerType;
    const fromPointer = e.detail !== 0 || (typeof pointerType === "string" && pointerType !== "");
    if (fromPointer && !(began && enteredRef.current)) return;
    decide("send");
  };

  // Why Send cannot be used yet, if it cannot. Display only: onSend decides.
  const hint = !windowActive
    ? t("authPrompt.hintFocusWindow")
    : !armed
      ? t("authPrompt.hintWait")
      : !entered && !keyboardOnSend
        ? t("authPrompt.hintMovePointer")
        : null;

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
    [t("authPrompt.address"), displayUrl(view.url)],
    [t("authPrompt.triggeredBy"), view.initiator !== null ? displayUrl(view.initiator) : t("authPrompt.notFromPage")],
    ...(view.redirectedFrom
      ? [[t("authPrompt.redirectedFrom"), displayUrl(view.redirectedFrom)] as [string, string]]
      : []),
    [t("authPrompt.login"), view.entryUsername ? `${view.entryTitle} (${view.entryUsername})` : view.entryTitle],
  ];

  return (
    <div className="p-4 flex flex-col gap-3 text-gray-900 dark:text-gray-100">
      <h1 className="text-sm font-semibold">{t("authPrompt.heading")}</h1>
      {view.insecure && (
        <p
          role="alert"
          className="text-xs text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-md px-2 py-1.5"
        >
          <span aria-hidden="true">⚠ </span>
          {t("authPrompt.httpWarning")}
        </p>
      )}
      <p className="text-xs" data-testid="auth-method">
        <span className="text-gray-500 dark:text-gray-400">{t("authPrompt.method")}: </span>
        {view.scheme === "digest" ? "Digest" : "Basic"}
      </p>
      <dl className="flex flex-col gap-1.5 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
      {/* Sticky: long details never push the buttons out of the window. */}
      <div className="sticky bottom-0 flex items-center gap-2 justify-end bg-white dark:bg-gray-900 py-2" data-testid="auth-actions">
        <p aria-live="polite" className="mr-auto text-xs text-gray-500 dark:text-gray-400" data-testid="auth-hint">
          {hint ?? ""}
        </p>
        <button
          type="button"
          onClick={() => decide("cancel")}
          className="h-9 px-4 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600"
        >
          {t("authPrompt.cancel")}
        </button>
        <button
          type="button"
          ref={sendRef}
          onPointerDown={onSendPointerDown}
          onFocus={onSendFocus}
          onBlur={() => setKeyboardOnSend(false)}
          onClick={onSend}
          // aria-disabled, not disabled: a disabled button swallows the
          // pointerdown that must restart the arm delay.
          aria-disabled={!armed}
          className={`h-9 px-4 rounded-md text-sm font-medium text-white bg-gray-900 dark:bg-gray-200 dark:text-gray-900 ${
            armed ? "hover:bg-gray-800 dark:hover:bg-gray-300" : "opacity-50 cursor-not-allowed"
          }`}
        >
          {t("authPrompt.send")}
        </button>
      </div>
    </div>
  );
}
