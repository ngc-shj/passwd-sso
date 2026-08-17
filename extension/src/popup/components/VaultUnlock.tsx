import { useState } from "react";
import { sendMessage } from "../../lib/messaging";
import { getSettings } from "../../lib/storage";
import { ensureHostPermission } from "../../lib/api";
import { humanizeError } from "../../lib/error-messages";
import { extractHost } from "../../lib/url-matching";
import { t } from "../../lib/i18n";

interface Props {
  onUnlocked: () => void;
  tabUrl?: string | null;
}

export function VaultUnlock({ onUnlocked, tabUrl }: Props) {
  const tabHost = tabUrl ? extractHost(tabUrl) : null;
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase) return;
    setLoading(true);
    setError("");

    // Any exit from here that is not a successful unlock re-masks the field: the
    // passphrase stays so the user can fix a typo, but leaving it legible until
    // the popup closes is a longer exposure than a retry needs. The finally
    // clause covers the awaits below rejecting — where an early return would
    // otherwise strand both the reveal and the loading state.
    let unlocked = false;
    try {
      const { serverUrl } = await getSettings();
      const granted = await ensureHostPermission(serverUrl);
      if (!granted) {
        setError("PERMISSION_DENIED");
        return;
      }

      const res = await sendMessage({ type: "UNLOCK_VAULT", passphrase });
      if (res.ok) {
        unlocked = true;
        setPassphrase("");
        onUnlocked();
      } else {
        setError(res.error || "INVALID_PASSPHRASE");
      }
    } catch {
      setError("UNLOCK_FAILED");
    } finally {
      setLoading(false);
      if (!unlocked) setShowPassphrase(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} onKeyDown={(e) => { if (e.key === "Enter" && e.nativeEvent.isComposing) e.preventDefault(); }} className="flex flex-col gap-4 py-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t("popup.unlockDescription")}
      </p>
      {tabHost && (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md">
          <span className="shrink-0">🌐</span>
          <span>{t("popup.unlockSite", { host: tabHost })}</span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          type={showPassphrase ? "text" : "password"}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder={t("popup.passphrasePlaceholder")}
          // Matches the web app's five passphrase inputs, which all declare
          // current-password. Revealing the field flips it to type="text", where
          // a browser would otherwise apply spellcheck and autocorrect to a
          // secret — hence the explicit opt-outs.
          autoComplete="current-password"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          className="h-10 flex-1 px-3 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-300 dark:focus:ring-gray-600 focus:border-gray-900 dark:focus:border-gray-400 transition-shadow"
          autoFocus
        />
        <button
          type="button"
          onClick={() => setShowPassphrase((v) => !v)}
          title={showPassphrase ? t("popup.hide") : t("popup.show")}
          // The icon carries no text, so without this the button has no
          // accessible name at all — screen readers announce only "button".
          aria-label={showPassphrase ? t("popup.hide") : t("popup.show")}
          className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 active:bg-gray-200 dark:active:bg-gray-700 transition-colors"
        >
          {showPassphrase ? (
            // Eye with a slash: the action offered is "conceal".
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>
          ) : (
            // Plain eye: the action offered is "reveal".
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          )}
        </button>
      </div>
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{humanizeError(error)}</p>
      )}
      <button
        type="submit"
        disabled={loading || !passphrase.trim()}
        className="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-md hover:bg-gray-800 dark:hover:bg-gray-200 active:bg-gray-950 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? t("popup.unlocking") : t("popup.unlock")}
      </button>
    </form>
  );
}
