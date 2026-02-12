import { useEffect, useState } from "react";
import { sendMessage } from "../../lib/messaging";
import {
  extractHost,
  isHostMatch,
  sortByUrlMatch,
} from "../../lib/url-matching";
import type { DecryptedEntry } from "../../types/messages";
import { humanizeError } from "../../lib/error-messages";
import { t } from "../../lib/i18n";
import { Toast } from "./Toast";

interface Props {
  tabUrl: string | null;
  onLock: () => void;
}

export function MatchList({ tabUrl, onLock }: Props) {
  const [entries, setEntries] = useState<DecryptedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filling, setFilling] = useState(false);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
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
    const res = await sendMessage({ type: "COPY_PASSWORD", entryId });
    if (res.password) {
      try {
        await navigator.clipboard.writeText(res.password);
        setToast({ message: t("popup.passwordCopied"), type: "success" });
        setTimeout(() => setToast(null), 2000);
        // Best-effort clipboard clear
        setTimeout(() => {
          navigator.clipboard.writeText("").catch(() => {});
        }, 30_000);
      } catch {
        setToast({ message: humanizeError("CLIPBOARD_FAILED"), type: "error" });
      }
    } else {
      setToast({ message: humanizeError(res.error || "COPY_FAILED"), type: "error" });
    }
  };

  const handleFill = async (entryId: string) => {
    if (filling) return;
    setFilling(true);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setToast({ message: humanizeError("NO_ACTIVE_TAB"), type: "error" });
      setFilling(false);
      return;
    }
    const res = await sendMessage({
      type: "AUTOFILL",
      entryId,
      tabId: tab.id,
    });
    if (res.ok) {
      setToast({ message: t("popup.autofillSent"), type: "success" });
      window.close();
    } else {
      setToast({ message: humanizeError(res.error || "AUTOFILL_FAILED"), type: "error" });
      setFilling(false);
    }
  };

  const sorted = sortByUrlMatch(entries, tabHost);
  const matched = tabHost
    ? sorted.filter((e) => e.urlHost && isHostMatch(e.urlHost, tabHost))
    : [];
  const unmatched = tabHost ? sorted.filter((e) => !matched.includes(e)) : sorted;

  const filterEntries = (list: DecryptedEntry[], q: string) => {
    if (!q) return list;
    const lower = q.toLowerCase();
    return list.filter(
      (e) =>
        e.title.toLowerCase().includes(lower) ||
        e.username.toLowerCase().includes(lower) ||
        e.urlHost.toLowerCase().includes(lower),
    );
  };
  const filteredMatched = filterEntries(matched, query);
  const filteredUnmatched = filterEntries(unmatched, query);

  return (
    <div className="flex flex-col gap-4 py-4">
      <Toast
        visible={!!toast}
        message={toast?.message || ""}
        type={toast?.type}
      />
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">{t("popup.passwords")}</h2>
        <button
          onClick={handleLock}
          className="text-xs text-gray-600 hover:text-gray-800"
        >
          {t("popup.lock")}
        </button>
      </div>

      {loading && <p className="text-sm text-gray-500">{t("popup.loading")}</p>}
      {!loading && error && (
        <p className="text-sm text-red-600">{humanizeError(error)}</p>
      )}
      {!loading && !error && entries.length === 0 && (
        <p className="text-sm text-gray-500">{t("popup.noEntries")}</p>
      )}

      {!loading && !error && entries.length > 0 && (
        <div className="flex flex-col gap-3">
          <input
            type="text"
            placeholder={t("popup.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 px-3 rounded-md border border-gray-300 text-sm"
          />

          {query && filteredMatched.length === 0 && filteredUnmatched.length === 0 && (
            <p className="text-sm text-gray-500">{t("popup.noResults", { query })}</p>
          )}

          {hasTabUrl && (
            <div className="text-xs font-medium text-gray-500">
              {tabHost
                ? filteredMatched.length > 0
                  ? t("popup.matchesFor", { host: tabHost })
                  : t("popup.noMatchesFor", { host: tabHost })
                : t("popup.noMatchesForPage")}
            </div>
          )}

          {filteredMatched.length > 0 && (
            <ul className="flex flex-col gap-2">
              {filteredMatched.map((e) => (
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
                          {t("popup.fill")}
                        </button>
                        <button
                          onClick={() => handleCopy(e.id)}
                          className="text-xs text-blue-700 hover:text-blue-900"
                        >
                          {t("popup.copy")}
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

          {tabHost && filteredUnmatched.length > 0 && (
            <div className="text-xs font-medium text-gray-500">{t("popup.otherEntries")}</div>
          )}

          {filteredUnmatched.length > 0 && (
            <ul className="flex flex-col gap-2">
              {filteredUnmatched.map((e) => (
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
                          {t("popup.fill")}
                        </button>
                        <button
                          onClick={() => handleCopy(e.id)}
                          className="text-xs text-blue-700 hover:text-blue-900"
                        >
                          {t("popup.copy")}
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

        </div>
      )}
    </div>
  );
}
