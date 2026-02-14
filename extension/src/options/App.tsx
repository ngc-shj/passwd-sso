import { useEffect, useState } from "react";
import { getSettings, setSettings, type StorageSchema } from "../lib/storage";
import { ensureHostPermission } from "../lib/api";
import { t } from "../lib/i18n";
import { humanizeError } from "../lib/error-messages";

const DEFAULT_SERVER_URL = "https://localhost:3000";

function validateServerUrl(raw: string): { ok: boolean; value: string; error?: string } {
  const trimmed = raw.trim() || DEFAULT_SERVER_URL;
  try {
    const url = new URL(trimmed);
    const isLocalhost =
      url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(isLocalhost && url.protocol === "http:")) {
      return { ok: false, value: trimmed, error: "HTTPS_REQUIRED" };
    }
    return { ok: true, value: url.origin };
  } catch {
    return { ok: false, value: trimmed, error: "INVALID_URL" };
  }
}

export function App() {
  const [serverUrl, setServerUrl] = useState("");
  const [autoLockMinutes, setAutoLockMinutes] = useState(15);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getSettings().then((s: StorageSchema) => {
      setServerUrl(s.serverUrl);
      setAutoLockMinutes(s.autoLockMinutes);
    });
  }, []);

  const handleSave = async () => {
    setSaved(false);
    setError("");
    const validated = validateServerUrl(serverUrl);
    if (!validated.ok) {
      setError(validated.error || "INVALID_URL");
      return;
    }

    if (autoLockMinutes < 0 || !Number.isFinite(autoLockMinutes)) {
      setError("AUTO_LOCK_INVALID");
      return;
    }

    const granted = await ensureHostPermission(validated.value);
    if (!granted) {
      setError("PERMISSION_DENIED");
      return;
    }

    await setSettings({
      serverUrl: validated.value,
      autoLockMinutes,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="max-w-lg mx-auto text-gray-900 px-6 py-10">
      <header className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{t("options.title")}</h1>
          <p className="text-sm text-gray-500 mt-1">{t("options.description")}</p>
        </div>
        <button
          type="button"
          onClick={() => window.close()}
          className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-200 rounded-md transition-colors"
          aria-label={t("options.close")}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
            <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
          </svg>
        </button>
      </header>

      <div className="flex flex-col gap-4">
        {/* Server URL */}
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-4 shadow-sm">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-gray-700">{t("options.serverUrl")}</span>
            <input
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder={t("options.serverUrlPlaceholder")}
              className="h-9 px-3 rounded-md border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
            />
            <span className="text-xs text-gray-400">
              {t("options.httpsRequired")}
            </span>
          </label>
        </div>

        {/* Auto-lock */}
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-4 shadow-sm">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-gray-700">
              {t("options.autoLock")}
            </span>
            <select
              value={autoLockMinutes}
              onChange={(e) => setAutoLockMinutes(Number(e.target.value))}
              className="h-9 px-3 rounded-md border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
            >
              <option value={0}>{t("options.never")}</option>
              <option value={1}>1</option>
              <option value={5}>5</option>
              <option value={15}>15</option>
              <option value={30}>30</option>
              <option value={60}>60</option>
            </select>
          </label>
        </div>

        {/* Save */}
        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={handleSave}
            className="px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 active:bg-blue-800 transition-colors shadow-sm"
          >
            {t("options.save")}
          </button>
          {error && <span className="text-sm text-red-600">{humanizeError(error)}</span>}
          {saved && <span className="text-sm text-green-600 font-medium">{t("options.saved")}</span>}
        </div>
      </div>
    </div>
  );
}
