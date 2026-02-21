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
import { EXT_ENTRY_TYPE } from "../../lib/constants";
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
  const isInsecurePage = tabUrl
    ? (() => {
        try {
          const url = new URL(tabUrl);
          return (
            url.protocol === "http:" &&
            url.hostname !== "localhost" &&
            url.hostname !== "127.0.0.1"
          );
        } catch {
          return false;
        }
      })()
    : false;

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

  const handleCopyTotp = async (entryId: string) => {
    const res = await sendMessage({ type: "COPY_TOTP", entryId });
    if (res.code) {
      try {
        await navigator.clipboard.writeText(res.code);
        setToast({ message: t("popup.totpCopied"), type: "success" });
        setTimeout(() => setToast(null), 2000);
        setTimeout(() => {
          navigator.clipboard.writeText("").catch(() => {});
        }, 30_000);
      } catch {
        setToast({ message: humanizeError("CLIPBOARD_FAILED"), type: "error" });
      }
    } else {
      setToast({
        message: humanizeError(res.error || "COPY_TOTP_FAILED"),
        type: "error",
      });
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
      {isInsecurePage && (
        <div className="flex items-start gap-2 px-3 py-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md">
          <span className="shrink-0 mt-0.5">⚠</span>
          <span>{t("popup.httpWarning")}</span>
        </div>
      )}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">{t("popup.passwords")}</h2>
        <button
          onClick={handleLock}
          className="text-xs font-semibold text-white bg-gray-900 px-2.5 py-1.5 rounded-md hover:bg-gray-800 active:bg-gray-950 transition-colors"
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
            className="h-9 px-3 rounded-md border border-gray-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-gray-300 focus:border-gray-900 transition-shadow"
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
                  className="rounded-md border border-gray-200 bg-gray-50 hover:bg-gray-100 transition-colors px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate min-w-0">
                      {e.title || "(Untitled)"}
                    </div>
                    {e.entryType === EXT_ENTRY_TYPE.LOGIN && (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => handleFill(e.id)}
                          disabled={filling}
                          className="text-xs font-semibold text-white bg-gray-900 px-2.5 py-1.5 rounded-md hover:bg-gray-800 active:bg-gray-950 transition-colors disabled:opacity-60"
                        >
                          {t("popup.fill")}
                        </button>
                        <button
                          onClick={() => handleCopyTotp(e.id)}
                          className="text-xs font-semibold text-gray-800 bg-gray-100 border border-gray-200 px-2.5 py-1.5 rounded-md hover:bg-gray-200 active:bg-gray-300 transition-colors"
                        >
                          {t("popup.copyTotp")}
                        </button>
                        <button
                          onClick={() => handleCopy(e.id)}
                          className="text-xs font-semibold text-gray-800 bg-gray-100 border border-gray-200 px-2.5 py-1.5 rounded-md hover:bg-gray-200 active:bg-gray-300 transition-colors"
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
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate min-w-0">
                      {e.title || "(Untitled)"}
                    </div>
                    {e.entryType === EXT_ENTRY_TYPE.LOGIN && (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => handleFill(e.id)}
                          disabled={filling}
                          className="text-xs font-semibold text-white bg-gray-900 px-2.5 py-1.5 rounded-md hover:bg-gray-800 active:bg-gray-950 transition-colors disabled:opacity-60"
                        >
                          {t("popup.fill")}
                        </button>
                        <button
                          onClick={() => handleCopyTotp(e.id)}
                          className="text-xs font-semibold text-gray-800 bg-gray-100 border border-gray-200 px-2.5 py-1.5 rounded-md hover:bg-gray-200 active:bg-gray-300 transition-colors"
                        >
                          {t("popup.copyTotp")}
                        </button>
                        <button
                          onClick={() => handleCopy(e.id)}
                          className="text-xs font-semibold text-gray-800 bg-gray-100 border border-gray-200 px-2.5 py-1.5 rounded-md hover:bg-gray-200 active:bg-gray-300 transition-colors"
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
