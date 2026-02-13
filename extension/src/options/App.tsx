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
  const [autofillAllEnabled, setAutofillAllEnabled] = useState(false);

  useEffect(() => {
    getSettings().then((s: StorageSchema) => {
      setServerUrl(s.serverUrl);
      setAutoLockMinutes(s.autoLockMinutes);
    });
    chrome.permissions
      .contains({ origins: ["https://*/*"] })
      .then(setAutofillAllEnabled)
      .catch(() => {});
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
    <div className="bg-white text-gray-900 p-5">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">{t("options.title")}</h1>
        <p className="text-sm text-gray-500">{t("options.description")}</p>
      </header>

      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-gray-700">{t("options.serverUrl")}</span>
          <input
            type="text"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder={t("options.serverUrlPlaceholder")}
            className="h-10 px-3 rounded-md border border-gray-300 text-sm"
          />
          <span className="text-xs text-gray-500">
            {t("options.httpsRequired")}
          </span>
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-gray-700">
            {t("options.autoLock")}
          </span>
          <select
            value={autoLockMinutes}
            onChange={(e) => setAutoLockMinutes(Number(e.target.value))}
            className="h-10 px-3 rounded-md border border-gray-300 text-sm"
          >
            <option value={0}>{t("options.never")}</option>
            <option value={1}>1</option>
            <option value={5}>5</option>
            <option value={15}>15</option>
            <option value={30}>30</option>
            <option value={60}>60</option>
          </select>
        </label>

        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium text-gray-700">
              {t("options.enableAutofillAll")}
            </span>
            <p className="text-xs text-gray-500">
              {t("options.enableAutofillAllDescription")}
            </p>
          </div>
          <button
            type="button"
            onClick={async () => {
              if (autofillAllEnabled) {
                const removed = await chrome.permissions.remove({
                  origins: ["https://*/*"],
                });
                if (removed) setAutofillAllEnabled(false);
              } else {
                const granted = await chrome.permissions.request({
                  origins: ["https://*/*"],
                });
                setAutofillAllEnabled(granted);
              }
            }}
            className={`relative flex-shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              autofillAllEnabled ? "bg-blue-600" : "bg-gray-300"
            }`}
            role="switch"
            aria-checked={autofillAllEnabled}
            aria-label={t("options.enableAutofillAll")}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                autofillAllEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors"
          >
            {t("options.save")}
          </button>
          {error && <span className="text-sm text-red-600">{humanizeError(error)}</span>}
          {saved && <span className="text-sm text-green-600">{t("options.saved")}</span>}
        </div>
      </div>
    </div>
  );
}
