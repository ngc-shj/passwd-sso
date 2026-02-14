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

    const { serverUrl } = await getSettings();
    const granted = await ensureHostPermission(serverUrl);
    if (!granted) {
      setError("PERMISSION_DENIED");
      setLoading(false);
      return;
    }

    const res = await sendMessage({ type: "UNLOCK_VAULT", passphrase });
    setLoading(false);
    if (res.ok) {
      setPassphrase("");
      onUnlocked();
    } else {
      setError(res.error || "INVALID_PASSPHRASE");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 py-4">
      <p className="text-sm text-gray-600">
        {t("popup.unlockDescription")}
      </p>
      {tabHost && (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-md">
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
          className="h-10 flex-1 px-3 rounded-md border border-gray-300 text-sm"
          autoFocus
        />
        <button
          type="button"
          onClick={() => setShowPassphrase((v) => !v)}
          className="text-xs text-gray-600 px-2 py-1 rounded hover:bg-gray-100 hover:text-gray-800 active:bg-gray-200 transition-colors"
        >
          {showPassphrase ? t("popup.hide") : t("popup.show")}
        </button>
      </div>
      {error && (
        <p className="text-sm text-red-600">{humanizeError(error)}</p>
      )}
      <button
        type="submit"
        disabled={loading}
        className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 active:bg-blue-800 transition-colors disabled:opacity-60"
      >
        {loading ? t("popup.unlocking") : t("popup.unlock")}
      </button>
    </form>
  );
}
