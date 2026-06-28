import { useEffect, useState } from "react";
import { sendMessage } from "../../lib/messaging";
import {
  extractHost,
  isHostMatch,
  sortByUrlMatch,
} from "../../lib/url-matching";
import type { DecryptedEntry } from "../../types/messages";
import { humanizeError } from "../../lib/error-messages";
import { getSettings } from "../../lib/storage";
import { t } from "../../lib/i18n";
import { EXT_ENTRY_TYPE } from "../../lib/constants";
import { MS_PER_SECOND } from "../../lib/time";
import { Toast } from "./Toast";
import { FillMismatchDialog } from "./FillMismatchDialog";

interface Props {
  tabUrl: string | null;
}

export function MatchList({ tabUrl }: Props) {
  const [entries, setEntries] = useState<DecryptedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filling, setFilling] = useState(false);
  const [query, setQuery] = useState("");
  const [pendingFill, setPendingFill] = useState<DecryptedEntry | null>(null);
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

  const copyAndScheduleClear = async (value: string, successMsg: string) => {
    await navigator.clipboard.writeText(value);
    setToast({ message: successMsg, type: "success" });
    setTimeout(() => setToast(null), 2000);
    const { clipboardClearSeconds } = await getSettings();
    setTimeout(() => { navigator.clipboard.writeText("").catch(() => {}); }, clipboardClearSeconds * MS_PER_SECOND);
  };

  const handleCopyUsername = async (entry: DecryptedEntry) => {
    // Username is already decrypted in the overview (entry.username, rendered below),
    // so copy it directly — no SW round-trip like password/TOTP need.
    if (!entry.username) return;
    try {
      await copyAndScheduleClear(entry.username, t("popup.usernameCopied"));
    } catch {
      setToast({ message: humanizeError("CLIPBOARD_FAILED"), type: "error" });
    }
  };

  const handleCopy = async (entryId: string, teamId?: string) => {
    const res = await sendMessage({ type: "COPY_PASSWORD", entryId, teamId });
    if (res.password) {
      try { await copyAndScheduleClear(res.password, t("popup.passwordCopied")); }
      catch { setToast({ message: humanizeError("CLIPBOARD_FAILED"), type: "error" }); }
    } else {
      setToast({ message: humanizeError(res.error || "COPY_FAILED"), type: "error" });
    }
  };

  const handleCopyTotp = async (entryId: string, teamId?: string) => {
    const res = await sendMessage({ type: "COPY_TOTP", entryId, teamId });
    if (res.code) {
      try { await copyAndScheduleClear(res.code, t("popup.totpCopied")); }
      catch { setToast({ message: humanizeError("CLIPBOARD_FAILED"), type: "error" }); }
    } else {
      setToast({ message: humanizeError(res.error || "COPY_TOTP_FAILED"), type: "error" });
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
    if (type === EXT_ENTRY_TYPE.PASSKEY) {
      return <span className="text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">{t("popup.badgePasskey")}</span>;
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
        if (e.entryType === EXT_ENTRY_TYPE.PASSKEY) return false;
        if (e.urlHost && isHostMatch(e.urlHost, tabHost)) return true;
        return (e.additionalUrlHosts ?? []).some((h) => isHostMatch(h, tabHost));
      })
    : [];
  const unmatchedAll = tabHost ? sorted.filter((e) => !matched.includes(e)) : sorted;
  // On non-web pages (chrome://, extension pages, etc.) no entries are relevant.
  // On web pages, show non-LOGIN entries (cards, identity) in "other" section.
  // Mismatched LOGINs are reachable via search only (where Fill goes through the
  // confirmation sheet). PASSKEY entries are excluded: they are handled by the
  // WebAuthn interceptor, not by popup autofill.
  const unmatched = tabHost
    ? unmatchedAll.filter(
        (e) => e.entryType !== EXT_ENTRY_TYPE.LOGIN && e.entryType !== EXT_ENTRY_TYPE.PASSKEY,
      )
    : [];

  const displayHost = (e: DecryptedEntry): string => {
    if (e.urlHost && tabHost && isHostMatch(e.urlHost, tabHost)) return e.urlHost;
    if (tabHost) {
      const additionalMatch = (e.additionalUrlHosts ?? []).find((h) => isHostMatch(h, tabHost));
      if (additionalMatch) return additionalMatch;
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

  // Search mode: query applied to the FULL sorted entry set (FR1/FR3)
  const isSearching = query !== "";
  const searchResults = filterEntries(sorted, query);

  const entryMatchesTab = (e: DecryptedEntry): boolean =>
    tabHost !== null &&
    ((e.urlHost ? isHostMatch(e.urlHost, tabHost) : false) ||
      (e.additionalUrlHosts ?? []).some((h) => isHostMatch(h, tabHost)));

  const storedHost = (e: DecryptedEntry): string =>
    e.urlHost || e.additionalUrlHosts?.[0] || "";

  // canShowFill: the Fill button renders for any autofillable entry on a web page.
  // The matched/mismatched decision lives in requestFill, not in button visibility.
  const canShowFill = (e: DecryptedEntry): boolean =>
    isAutofillable(e.entryType) && tabHost !== null;

  // A mismatched LOGIN with a stored host is filled only after the user confirms in
  // the sheet (phishing safeguard). Everything else fills directly.
  const requestFill = (e: DecryptedEntry) => {
    if (
      e.entryType === EXT_ENTRY_TYPE.LOGIN &&
      storedHost(e) !== "" &&
      !entryMatchesTab(e)
    ) {
      setPendingFill(e);
      return;
    }
    void handleFill(e.id, e.entryType, e.teamId);
  };

  const renderEntryRow = (e: DecryptedEntry, variant: "matched" | "plain") => {
    const liClass =
      variant === "matched"
        ? "rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors px-3 py-2"
        : "rounded-md border border-gray-200 dark:border-gray-700 px-3 py-2";
    const h = displayHost(e);
    return (
      <li key={`${e.teamId ?? "personal"}-${e.id}`} className={liClass}>
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-1.5 truncate min-w-0">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
              {e.title || "(Untitled)"}
            </span>
            {entryTypeBadge(e.entryType)}
            {teamBadge(e.teamName)}
          </div>
          {(canShowFill(e) || e.entryType === EXT_ENTRY_TYPE.LOGIN) && (
            <div className="flex items-center gap-1 shrink-0">
              {canShowFill(e) && (
                <button
                  onClick={() => requestFill(e)}
                  disabled={filling}
                  title={t("popup.fill")}
                  className="p-1.5 rounded-md text-white bg-gray-900 dark:bg-gray-200 dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-300 active:bg-gray-950 transition-colors disabled:opacity-60"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                </button>
              )}
              {e.entryType === EXT_ENTRY_TYPE.LOGIN && (
                <>
                  {e.username && (
                    <button
                      onClick={() => handleCopyUsername(e)}
                      title={t("popup.copyUsername")}
                      className="p-1.5 rounded-md text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-600 active:bg-gray-300 dark:active:bg-gray-500 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    </button>
                  )}
                  <button
                    onClick={() => handleCopyTotp(e.id, e.teamId)}
                    title={t("popup.copyTotp")}
                    className="p-1.5 rounded-md text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-600 active:bg-gray-300 dark:active:bg-gray-500 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  </button>
                  <button
                    onClick={() => handleCopy(e.id, e.teamId)}
                    title={t("popup.copy")}
                    className="p-1.5 rounded-md text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-600 active:bg-gray-300 dark:active:bg-gray-500 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        {e.username && (
          <div className="text-xs text-gray-600 dark:text-gray-400">{e.username}</div>
        )}
        {h ? <div className="text-xs text-gray-500 dark:text-gray-400">{h}</div> : null}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <Toast
        visible={!!toast}
        message={toast?.message || ""}
        type={toast?.type}
      />
      {pendingFill && (
        <FillMismatchDialog
          title={pendingFill.title || "(Untitled)"}
          savedHost={storedHost(pendingFill)}
          currentHost={tabHost}
          onConfirm={() => {
            const entry = pendingFill;
            setPendingFill(null);
            void handleFill(entry.id, entry.entryType, entry.teamId);
          }}
          onCancel={() => setPendingFill(null)}
        />
      )}
      {isInsecurePage && (
        <div className="flex items-start gap-2 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-md">
          <span className="shrink-0 mt-0.5">⚠</span>
          <span>{t("popup.httpWarning")}</span>
        </div>
      )}

      {loading && <p className="text-sm text-gray-500 dark:text-gray-400">{t("popup.loading")}</p>}
      {!loading && error && (
        <p className="text-sm text-red-600 dark:text-red-400">{humanizeError(error)}</p>
      )}
      {!loading && !error && entries.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t("popup.noEntries")}</p>
      )}

      {!loading && !error && entries.length > 0 && (
        <div className="flex flex-col gap-2">
          <input
            type="text"
            placeholder={t("popup.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 px-2.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-xs text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-300 dark:focus:ring-gray-600 focus:border-gray-900 dark:focus:border-gray-400 transition-shadow"
          />

          {isSearching && (
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400">
              {t("popup.searchResults")}
            </div>
          )}

          {isSearching && searchResults.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">{t("popup.noResults", { query })}</p>
          )}

          {isSearching && searchResults.length > 0 && (
            <ul className="flex flex-col gap-2">
              {searchResults.map((e) => renderEntryRow(e, "plain"))}
            </ul>
          )}

          {!isSearching && hasTabUrl && (
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400">
              {tabHost
                ? matched.length > 0
                  ? t("popup.matchesFor", { host: tabHost })
                  : t("popup.noMatchesFor", { host: tabHost })
                : t("popup.noMatchesForPage")}
            </div>
          )}

          {!isSearching && matched.length > 0 && (
            <ul className="flex flex-col gap-2">
              {matched.map((e) => renderEntryRow(e, "matched"))}
            </ul>
          )}

          {!isSearching && tabHost && unmatched.length > 0 && (
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{t("popup.otherEntries")}</div>
          )}

          {!isSearching && unmatched.length > 0 && (
            <ul className="flex flex-col gap-2">
              {unmatched.map((e) => renderEntryRow(e, "plain"))}
            </ul>
          )}

        </div>
      )}
    </div>
  );
}
