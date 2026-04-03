import { useEffect, useState } from "react";
import { getSettings, validateSettings, Theme } from "./storage";

/** Apply the resolved theme class to <html>. */
export function applyTheme(theme: Theme): void {
  const resolved =
    theme === Theme.SYSTEM
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? Theme.DARK
        : Theme.LIGHT
      : theme;
  document.documentElement.classList.toggle("dark", resolved === Theme.DARK);
}

/**
 * Apply theme from chrome.storage.local before React render.
 * Uses validateSettings to ensure the stored value is valid.
 */
export async function initTheme(): Promise<void> {
  const s = await getSettings();
  applyTheme(validateSettings(s).theme);
}

/** React hook that tracks the current theme and applies it to <html>. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(Theme.SYSTEM);

  useEffect(() => {
    getSettings().then((s) => {
      const t = validateSettings(s).theme;
      setThemeState(t);
      applyTheme(t);
    });
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (theme === Theme.SYSTEM) applyTheme(Theme.SYSTEM);
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
