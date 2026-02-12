import { useEffect, useState } from "react";
import { sendMessage } from "../../lib/messaging";
import {
  extractHost,
  isHostMatch,
  sortByUrlMatch,
} from "../../lib/url-matching";
import type { DecryptedEntry } from "../../types/messages";
import { humanizeError } from "../../lib/error-messages";

interface Props {
  tabUrl: string | null;
  onLock: () => void;
}

export function MatchList({ tabUrl, onLock }: Props) {
  const [entries, setEntries] = useState<DecryptedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [filling, setFilling] = useState(false);
  const [fillError, setFillError] = useState<string | null>(null);
  const hasTabUrl = Boolean(tabUrl);
  const tabHost = tabUrl ? extractHost(tabUrl) : null;

  useEffect(() => {
    sendMessage({ type: "FETCH_PASSWORDS" }).then((res) => {
      if (res.entries) {
        setEntries(res.entries);
      } else {
        setError(res.error || "FETCH_FAILED");
      }
      setLoading(false);
    });
  }, []);

  const handleLock = async () => {
    await sendMessage({ type: "LOCK_VAULT" });
    onLock();
  };

  const handleCopy = async (entryId: string) => {
    setCopyError(null);
    const res = await sendMessage({ type: "COPY_PASSWORD", entryId });
    if (res.password) {
      try {
        await navigator.clipboard.writeText(res.password);
        setCopiedId(entryId);
        setTimeout(() => setCopiedId(null), 2000);
        // Best-effort clipboard clear
        setTimeout(() => {
          navigator.clipboard.writeText("").catch(() => {});
        }, 30_000);
      } catch {
        setCopyError("CLIPBOARD_FAILED");
      }
    } else {
      setCopyError(res.error || "COPY_FAILED");
    }
  };

  const handleFill = async (entryId: string) => {
    if (filling) return;
    setFillError(null);
    setFilling(true);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setFillError("NO_ACTIVE_TAB");
      setFilling(false);
      return;
    }
    const res = await sendMessage({
      type: "AUTOFILL",
      entryId,
      tabId: tab.id,
    });
    if (res.ok) {
      window.close();
    } else {
      setFillError(res.error || "AUTOFILL_FAILED");
      setFilling(false);
    }
  };

  const sorted = sortByUrlMatch(entries, tabHost);
  const matched = tabHost
    ? sorted.filter((e) => e.urlHost && isHostMatch(e.urlHost, tabHost))
    : [];
  const unmatched = tabHost ? sorted.filter((e) => !matched.includes(e)) : sorted;

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Passwords</h2>
        <button
          onClick={handleLock}
          className="text-xs text-gray-600 hover:text-gray-800"
        >
          Lock
        </button>
      </div>

      {loading && <p className="text-sm text-gray-500">Loading...</p>}
      {!loading && error && (
        <p className="text-sm text-red-600">{humanizeError(error)}</p>
      )}
      {!loading && !error && entries.length === 0 && (
        <p className="text-sm text-gray-500">No entries found.</p>
      )}

      {!loading && !error && entries.length > 0 && (
        <div className="flex flex-col gap-3">
          {hasTabUrl && (
            <div className="text-xs font-medium text-gray-500">
              {tabHost
                ? matched.length > 0
                  ? `Matches for ${tabHost}`
                  : `No matches for ${tabHost}`
                : "No matches for this page"}
            </div>
          )}

          {matched.length > 0 && (
            <ul className="flex flex-col gap-2">
              {matched.map((e) => (
                <li
                  key={e.id}
                  className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-gray-900">
                      {e.title || "(Untitled)"}
                    </div>
                    {e.entryType === "LOGIN" && (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleFill(e.id)}
                          disabled={filling}
                          className="text-xs text-gray-700 hover:text-gray-900 disabled:opacity-60"
                        >
                          Fill
                        </button>
                        <button
                          onClick={() => handleCopy(e.id)}
                          className="text-xs text-blue-700 hover:text-blue-900"
                        >
                          {copiedId === e.id ? "Copied!" : "Copy"}
                        </button>
                      </div>
                    )}
                  </div>
                  {e.username && (
                    <div className="text-xs text-gray-600">{e.username}</div>
                  )}
                  {e.urlHost && (
                    <div className="text-xs text-gray-500">{e.urlHost}</div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {tabHost && unmatched.length > 0 && (
            <div className="text-xs font-medium text-gray-500">Other entries</div>
          )}

          {unmatched.length > 0 && (
            <ul className="flex flex-col gap-2">
              {unmatched.map((e) => (
                <li
                  key={e.id}
                  className="rounded-md border border-gray-200 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-gray-900">
                      {e.title || "(Untitled)"}
                    </div>
                    {e.entryType === "LOGIN" && (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleFill(e.id)}
                          disabled={filling}
                          className="text-xs text-gray-700 hover:text-gray-900 disabled:opacity-60"
                        >
                          Fill
                        </button>
                        <button
                          onClick={() => handleCopy(e.id)}
                          className="text-xs text-blue-700 hover:text-blue-900"
                        >
                          {copiedId === e.id ? "Copied!" : "Copy"}
                        </button>
                      </div>
                    )}
                  </div>
                  {e.username && (
                    <div className="text-xs text-gray-600">{e.username}</div>
                  )}
                  {e.urlHost && (
                    <div className="text-xs text-gray-500">{e.urlHost}</div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {copyError && (
            <p className="text-xs text-red-600">{humanizeError(copyError)}</p>
          )}
          {fillError && (
            <p className="text-xs text-red-600">{humanizeError(fillError)}</p>
          )}
        </div>
      )}
    </div>
  );
}
