import { useState } from "react";
import { sendMessage } from "../../lib/messaging";
import { getSettings } from "../../lib/storage";
import { ensureHostPermission } from "../../lib/api";
import { humanizeError } from "../../lib/error-messages";

interface Props {
  onUnlocked: () => void;
}

export function VaultUnlock({ onUnlocked }: Props) {
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
        Enter your master passphrase to unlock the vault.
      </p>
      <div className="flex items-center gap-2">
        <input
          type={showPassphrase ? "text" : "password"}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="Passphrase"
          className="h-10 flex-1 px-3 rounded-md border border-gray-300 text-sm"
          autoFocus
        />
        <button
          type="button"
          onClick={() => setShowPassphrase((v) => !v)}
          className="text-xs text-gray-600 hover:text-gray-800"
        >
          {showPassphrase ? "Hide" : "Show"}
        </button>
      </div>
      {error && (
        <p className="text-sm text-red-600">{humanizeError(error)}</p>
      )}
      <button
        type="submit"
        disabled={loading}
        className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors disabled:opacity-60"
      >
        {loading ? "Unlocking..." : "Unlock"}
      </button>
    </form>
  );
}
