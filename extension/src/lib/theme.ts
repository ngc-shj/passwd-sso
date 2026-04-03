import { useEffect, useState } from "react";
import { getSettings } from "./storage";

type Theme = "light" | "dark" | "system";
const VALID = new Set<string>(["light", "dark", "system"]);

/** Apply the resolved theme class to <html>. */
export function applyTheme(theme: Theme): void {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

/**
 * Apply theme from chrome.storage.local before React render.
 * Returns a promise that resolves after the theme class is set.
 * Call with `await` before createRoot().render().
 */
export async function initTheme(): Promise<void> {
  const result = await chrome.storage.local.get({ theme: "system" });
  const raw = result.theme;
  const theme: Theme = typeof raw === "string" && VALID.has(raw) ? (raw as Theme) : "system";
  applyTheme(theme);
}

/** React hook that tracks the current theme and applies it to <html>. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>("system");

  useEffect(() => {
    getSettings().then((s) => {
      const t: Theme = VALID.has(s.theme) ? s.theme : "system";
      setThemeState(t);
      applyTheme(t);
    });
  }, []);

  // Listen for OS theme changes when in "system" mode
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (theme === "system") applyTheme("system");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    applyTheme(t);
  };

  return [theme, setTheme];
}
