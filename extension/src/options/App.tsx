import { useEffect, useState } from "react";
import { getSettings, setSettings, type StorageSchema } from "../lib/storage";
import { ensureHostPermission } from "../lib/api";

const DEFAULT_SERVER_URL = "https://localhost:3000";

function validateServerUrl(raw: string): { ok: boolean; value: string; error?: string } {
  const trimmed = raw.trim() || DEFAULT_SERVER_URL;
  try {
    const url = new URL(trimmed);
    const isLocalhost =
      url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(isLocalhost && url.protocol === "http:")) {
      return { ok: false, value: trimmed, error: "https is required (http allowed for localhost)" };
    }
    return { ok: true, value: url.origin };
  } catch {
    return { ok: false, value: trimmed, error: "Invalid URL" };
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
      setError(validated.error || "Invalid URL");
      return;
    }

    if (autoLockMinutes < 0 || !Number.isFinite(autoLockMinutes)) {
      setError("Auto-lock minutes must be 0 or more");
      return;
    }

    const granted = await ensureHostPermission(validated.value);
    if (!granted) {
      setError("Host permission denied");
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
    <div className="min-h-[520px] bg-white text-gray-900 p-5">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-gray-500">
          Configure server connection and auto-lock behavior.
        </p>
      </header>

      <div className="flex flex-col gap-5">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-gray-700">Server URL</span>
          <input
            type="text"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="https://example.com"
            className="h-10 px-3 rounded-md border border-gray-300 text-sm"
          />
          <span className="text-xs text-gray-500">
            HTTPS required (HTTP allowed for localhost).
          </span>
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-gray-700">
            Auto-lock (minutes)
          </span>
          <select
            value={autoLockMinutes}
            onChange={(e) => setAutoLockMinutes(Number(e.target.value))}
            className="h-10 px-3 rounded-md border border-gray-300 text-sm"
          >
            <option value={0}>Never</option>
            <option value={1}>1</option>
            <option value={5}>5</option>
            <option value={15}>15</option>
            <option value={30}>30</option>
            <option value={60}>60</option>
          </select>
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {saved && <p className="text-sm text-green-600">Saved!</p>}

        <button
          onClick={handleSave}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors"
        >
          Save
        </button>
      </div>
    </div>
  );
}
