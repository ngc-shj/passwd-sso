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
}

export function MatchList({ tabUrl }: Props) {
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

  const handleCopy = async (entryId: string, teamId?: string) => {
    const res = await sendMessage({ type: "COPY_PASSWORD", entryId, teamId });
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

  const handleCopyTotp = async (entryId: string, teamId?: string) => {
    const res = await sendMessage({ type: "COPY_TOTP", entryId, teamId });
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

  const handleFill = async (entryId: string, entryType: string, teamId?: string) => {
    if (filling) return;
    setFilling(true);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setToast({ message: humanizeError("NO_ACTIVE_TAB"), type: "error" });
      setFilling(false);
      return;
    }

    let msgType: "AUTOFILL" | "AUTOFILL_CREDIT_CARD" | "AUTOFILL_IDENTITY" = "AUTOFILL";
    if (entryType === EXT_ENTRY_TYPE.CREDIT_CARD) msgType = "AUTOFILL_CREDIT_CARD";
    else if (entryType === EXT_ENTRY_TYPE.IDENTITY) msgType = "AUTOFILL_IDENTITY";

    const res = await sendMessage({
      type: msgType,
      entryId,
      tabId: tab.id,
      teamId,
    });
    if (res.ok) {
      setToast({ message: t("popup.autofillSent"), type: "success" });
      window.close();
    } else {
      setToast({ message: humanizeError(res.error || "AUTOFILL_FAILED"), type: "error" });
      setFilling(false);
    }
  };

  const entryTypeBadge = (type: string) => {
    if (type === EXT_ENTRY_TYPE.CREDIT_CARD) {
      return <span className="text-[10px] font-medium text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded">{t("popup.badgeCard")}</span>;
    }
    if (type === EXT_ENTRY_TYPE.IDENTITY) {
      return <span className="text-[10px] font-medium text-green-700 bg-green-50 border border-green-200 px-1.5 py-0.5 rounded">{t("popup.badgeIdentity")}</span>;
    }
    return null;
  };

  const teamBadge = (teamName?: string) => {
    if (!teamName) return null;
    return <span className="text-[10px] font-medium text-purple-700 bg-purple-50 border border-purple-200 px-1.5 py-0.5 rounded truncate max-w-[80px]">{teamName}</span>;
  };

  const isAutofillable = (type: string) =>
    type === EXT_ENTRY_TYPE.LOGIN ||
    type === EXT_ENTRY_TYPE.CREDIT_CARD ||
    type === EXT_ENTRY_TYPE.IDENTITY;

  const sorted = sortByUrlMatch(entries, tabHost);
  const matched = tabHost
    ? sorted.filter((e) => {
        if (e.urlHost && isHostMatch(e.urlHost, tabHost)) return true;
        return (e.additionalUrlHosts ?? []).some((h) => isHostMatch(h, tabHost));
      })
    : [];
  const unmatchedAll = tabHost ? sorted.filter((e) => !matched.includes(e)) : sorted;
  // When viewing a specific site, only show non-LOGIN entries (cards, identity)
  // in the "other" section — unrelated login entries are noise.
  const unmatched = tabHost
    ? unmatchedAll.filter((e) => e.entryType !== EXT_ENTRY_TYPE.LOGIN)
    : unmatchedAll;

  const displayHost = (e: DecryptedEntry): string => {
    if (e.urlHost && tabHost && isHostMatch(e.urlHost, tabHost)) return e.urlHost;
    if (tabHost) {
      const matched = (e.additionalUrlHosts ?? []).find((h) => isHostMatch(h, tabHost));
      if (matched) return matched;
    }
    return e.urlHost || e.additionalUrlHosts?.[0] || "";
  };

  const filterEntries = (list: DecryptedEntry[], q: string) => {
    if (!q) return list;
    const lower = q.toLowerCase();
    return list.filter(
      (e) =>
        e.title.toLowerCase().includes(lower) ||
        e.username.toLowerCase().includes(lower) ||
        e.urlHost.toLowerCase().includes(lower) ||
        (e.additionalUrlHosts ?? []).some((h) => h.toLowerCase().includes(lower)),
    );
  };
  const filteredMatched = filterEntries(matched, query);
  const filteredUnmatched = filterEntries(unmatched, query);

  return (
    <div className="flex flex-col gap-2">
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

      {loading && <p className="text-sm text-gray-500">{t("popup.loading")}</p>}
      {!loading && error && (
        <p className="text-sm text-red-600">{humanizeError(error)}</p>
      )}
      {!loading && !error && entries.length === 0 && (
        <p className="text-sm text-gray-500">{t("popup.noEntries")}</p>
      )}

      {!loading && !error && entries.length > 0 && (
        <div className="flex flex-col gap-2">
          <input
            type="text"
            placeholder={t("popup.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 px-2.5 rounded-md border border-gray-300 bg-white text-xs focus:outline-none focus:ring-2 focus:ring-gray-300 focus:border-gray-900 transition-shadow"
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
                  key={`${e.teamId ?? "personal"}-${e.id}`}
                  className="rounded-md border border-gray-200 bg-gray-50 hover:bg-gray-100 transition-colors px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <div className="flex items-center gap-1.5 truncate min-w-0">
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {e.title || "(Untitled)"}
                      </span>
                      {entryTypeBadge(e.entryType)}
                      {teamBadge(e.teamName)}
                    </div>
                    {isAutofillable(e.entryType) && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => handleFill(e.id, e.entryType, e.teamId)}
                          disabled={filling}
                          title={t("popup.fill")}
                          className="p-1.5 rounded-md text-white bg-gray-900 hover:bg-gray-800 active:bg-gray-950 transition-colors disabled:opacity-60"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                        </button>
                        {e.entryType === EXT_ENTRY_TYPE.LOGIN && (
                          <>
                            <button
                              onClick={() => handleCopyTotp(e.id, e.teamId)}
                              title={t("popup.copyTotp")}
                              className="p-1.5 rounded-md text-gray-700 bg-gray-100 border border-gray-200 hover:bg-gray-200 active:bg-gray-300 transition-colors"
                            >
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                            </button>
                            <button
                              onClick={() => handleCopy(e.id, e.teamId)}
                              title={t("popup.copy")}
                              className="p-1.5 rounded-md text-gray-700 bg-gray-100 border border-gray-200 hover:bg-gray-200 active:bg-gray-300 transition-colors"
                            >
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  {e.username && (
                    <div className="text-xs text-gray-600">{e.username}</div>
                  )}
                  {displayHost(e) && (
                    <div className="text-xs text-gray-500">{displayHost(e)}</div>
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
                  key={`${e.teamId ?? "personal"}-${e.id}`}
                  className="rounded-md border border-gray-200 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <div className="flex items-center gap-1.5 truncate min-w-0">
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {e.title || "(Untitled)"}
                      </span>
                      {entryTypeBadge(e.entryType)}
                      {teamBadge(e.teamName)}
                    </div>
                    {isAutofillable(e.entryType) && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => handleFill(e.id, e.entryType, e.teamId)}
                          disabled={filling}
                          title={t("popup.fill")}
                          className="p-1.5 rounded-md text-white bg-gray-900 hover:bg-gray-800 active:bg-gray-950 transition-colors disabled:opacity-60"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                        </button>
                        {e.entryType === EXT_ENTRY_TYPE.LOGIN && (
                          <>
                            <button
                              onClick={() => handleCopyTotp(e.id, e.teamId)}
                              title={t("popup.copyTotp")}
                              className="p-1.5 rounded-md text-gray-700 bg-gray-100 border border-gray-200 hover:bg-gray-200 active:bg-gray-300 transition-colors"
                            >
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                            </button>
                            <button
                              onClick={() => handleCopy(e.id, e.teamId)}
                              title={t("popup.copy")}
                              className="p-1.5 rounded-md text-gray-700 bg-gray-100 border border-gray-200 hover:bg-gray-200 active:bg-gray-300 transition-colors"
                            >
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  {e.username && (
                    <div className="text-xs text-gray-600">{e.username}</div>
                  )}
                  {displayHost(e) && (
                    <div className="text-xs text-gray-500">{displayHost(e)}</div>
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
