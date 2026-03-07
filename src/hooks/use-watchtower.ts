"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useVault } from "@/lib/vault-context";
import { useTeamVaultOptional } from "@/lib/team-vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD, buildTeamEntryAAD } from "@/lib/crypto-aad";
import { API_PATH, ENTRY_TYPE, LOCAL_STORAGE_KEY, apiPath } from "@/lib/constants";
import { getCooldownState } from "@/lib/watchtower/state";
import {
  shouldAutoCheck,
  hasNewBreaches,
  LS_LAST_BREACH_CHECK_AT,
  LS_AUTO_MONITOR_ENABLED,
  LS_LAST_KNOWN_BREACH_COUNT,
} from "@/lib/watchtower/auto-monitor";
import {
  analyzeStrength,
  checkHIBP,
  delay,
  type StrengthResult,
} from "@/lib/password-analyzer";
import { fetchApi } from "@/lib/url-helpers";

// ─── Constants ──────────────────────────────────────────────

export const OLD_THRESHOLD_DAYS = 90;
export const EXPIRING_THRESHOLD_DAYS = 30;
export const WATCHTOWER_COOLDOWN_MS = 5 * 60 * 1000;

// ─── Types ───────────────────────────────────────────────────

export type IssueSeverity = "critical" | "high" | "medium" | "low";

export interface PersonalWatchtowerEntryRef {
  id: string;
  title: string;
  username: string | null;
  scope: "personal";
}

export interface TeamWatchtowerEntryRef {
  id: string;
  title: string;
  username: string | null;
  scope: "team";
  teamId: string;
}

export type WatchtowerEntryRef =
  | PersonalWatchtowerEntryRef
  | TeamWatchtowerEntryRef;

export type PasswordIssue = WatchtowerEntryRef & {
  severity: IssueSeverity;
  details: string;
};

export interface ReusedGroup {
  entries: WatchtowerEntryRef[];
}

export interface DuplicateGroup {
  hostname: string;
  username: string;
  entries: WatchtowerEntryRef[];
}

export interface WatchtowerReport {
  totalPasswords: number;
  overallScore: number;
  breached: PasswordIssue[];
  weak: PasswordIssue[];
  reused: ReusedGroup[];
  old: PasswordIssue[];
  unsecured: PasswordIssue[];
  duplicate: DuplicateGroup[];
  expiring: PasswordIssue[];
  analyzedAt: Date;
}

export interface WatchtowerProgress {
  current: number;
  total: number;
  step: string;
}

export type WatchtowerAnalysisUnavailableReason =
  | "personalKeyUnavailable"
  | "teamKeyUnavailable";

export type WatchtowerScope =
  | { type: "personal" }
  | { type: "team"; teamId: string };

interface DecryptedEntry {
  id: string;
  title: string;
  username: string | null;
  password: string;
  url: string | null;
  updatedAt: string;
  expiresAt: string | null;
  scope: "personal" | "team";
  teamId?: string;
}

interface FetchWatchtowerEntriesSuccess {
  status: "ok";
  entries: DecryptedEntry[];
}

interface FetchWatchtowerEntriesUnavailable {
  status: "unavailable";
  reason: WatchtowerAnalysisUnavailableReason;
}

type FetchWatchtowerEntriesResult =
  | FetchWatchtowerEntriesSuccess
  | FetchWatchtowerEntriesUnavailable;

function toWatchtowerEntryRef(entry: DecryptedEntry): WatchtowerEntryRef {
  if (entry.scope === "team") {
    if (!entry.teamId) {
      throw new Error("Missing teamId for team watchtower entry");
    }
    return {
      id: entry.id,
      title: entry.title,
      username: entry.username,
      scope: "team",
      teamId: entry.teamId,
    };
  }

  return {
    id: entry.id,
    title: entry.title,
    username: entry.username,
    scope: "personal",
  };
}

// ─── Hook ────────────────────────────────────────────────────

export function useWatchtower(scope: WatchtowerScope = { type: "personal" }) {
  const { encryptionKey, userId } = useVault();
  const teamVault = useTeamVaultOptional();
  const [report, setReport] = useState<WatchtowerReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailableReason, setUnavailableReason] =
    useState<WatchtowerAnalysisUnavailableReason | null>(null);
  const [lastAnalyzedAt, setLastAnalyzedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [progress, setProgress] = useState<WatchtowerProgress>({
    current: 0,
    total: 0,
    step: "",
  });

  useEffect(() => {
    const stored = window.localStorage.getItem(
      LOCAL_STORAGE_KEY.WATCHTOWER_LAST_ANALYZED_AT
    );
    if (!stored) return;
    const parsed = Number(stored);
    if (Number.isFinite(parsed)) setLastAnalyzedAt(parsed);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const { nextAllowedAt, cooldownRemainingMs, canAnalyze } = getCooldownState(
    lastAnalyzedAt,
    now,
    loading,
    WATCHTOWER_COOLDOWN_MS
  );

  const analyze = useCallback(async (
    options?: {
      bypassCooldown?: boolean;
      skipRateLimit?: boolean;
    },
  ) => {
    const bypassCooldown = options?.bypassCooldown === true;
    const skipRateLimit = options?.skipRateLimit === true;

    if (loading || (!bypassCooldown && cooldownRemainingMs > 0)) return;
    if (scope.type === "personal" && !encryptionKey) {
      setReport(null);
      setUnavailableReason("personalKeyUnavailable");
      return;
    }
    if (
      scope.type === "team" &&
      (!teamVault || typeof teamVault.getTeamEncryptionKey !== "function")
    ) {
      setReport(null);
      setUnavailableReason("teamKeyUnavailable");
      return;
    }

    let teamEncryptionKey: CryptoKey | undefined;
    const getTeamEncryptionKey =
      scope.type === "team" ? teamVault?.getTeamEncryptionKey : undefined;
    if (scope.type === "team") {
      if (!getTeamEncryptionKey) {
        setReport(null);
        setUnavailableReason("teamKeyUnavailable");
        return;
      }
      teamEncryptionKey = await getTeamEncryptionKey(scope.teamId) ?? undefined;
      if (!teamEncryptionKey) {
        setReport(null);
        setUnavailableReason("teamKeyUnavailable");
        return;
      }
    }

    if (!skipRateLimit) {
      const startRes = await fetchApi(API_PATH.WATCHTOWER_START, { method: "POST" });
      if (!startRes.ok) {
        if (startRes.status === 429) {
          const body = await startRes.json().catch(() => null) as { retryAt?: number } | null;
          if (typeof body?.retryAt === "number") {
            const startedAt = body.retryAt - WATCHTOWER_COOLDOWN_MS;
            setLastAnalyzedAt(startedAt);
            window.localStorage.setItem(
              LOCAL_STORAGE_KEY.WATCHTOWER_LAST_ANALYZED_AT,
              String(startedAt)
            );
          } else {
            const fallbackStartedAt = Date.now();
            setLastAnalyzedAt(fallbackStartedAt);
            window.localStorage.setItem(
              LOCAL_STORAGE_KEY.WATCHTOWER_LAST_ANALYZED_AT,
              String(fallbackStartedAt)
            );
          }
        }
        return;
      }
    }

    if (!bypassCooldown) {
      const startedAt = Date.now();
      setLastAnalyzedAt(startedAt);
      window.localStorage.setItem(
        LOCAL_STORAGE_KEY.WATCHTOWER_LAST_ANALYZED_AT,
        String(startedAt)
      );
    }

    setLoading(true);
    setUnavailableReason(null);

    try {
      // Step 1: Fetch and decrypt the selected vault's login entries
      setProgress({ current: 0, total: 4, step: "fetching" });
      const entryResult = await fetchWatchtowerEntries({
        scope,
        encryptionKey: encryptionKey ?? undefined,
        teamEncryptionKey,
        userId: userId ?? undefined,
        getTeamEncryptionKey,
      });

      if (entryResult.status === "unavailable") {
        setReport(null);
        setUnavailableReason(entryResult.reason);
        return;
      }

      const entries = entryResult.entries;

      if (entries.length === 0) {
        setReport({
          totalPasswords: 0,
          overallScore: 100,
          breached: [],
          weak: [],
          reused: [],
          old: [],
          unsecured: [],
          duplicate: [],
          expiring: [],
          analyzedAt: new Date(),
        });
        return;
      }

      // Step 2: Local analysis (duplicates, strength, age)
      setProgress({ current: 2, total: 4, step: "analyzing" });

      // Duplicate detection via hash comparison
      const hashMap = new Map<string, DecryptedEntry[]>();
      for (const entry of entries) {
        const encoder = new TextEncoder();
        const hashBuf = await crypto.subtle.digest(
          "SHA-256",
          encoder.encode(entry.password)
        );
        const hash = Array.from(new Uint8Array(hashBuf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const group = hashMap.get(hash) ?? [];
        group.push(entry);
        hashMap.set(hash, group);
      }

      const reused: ReusedGroup[] = [];
      for (const group of hashMap.values()) {
        if (group.length > 1) {
          reused.push({
            entries: group.map(toWatchtowerEntryRef),
          });
        }
      }

      // Strength analysis
      const strengthMap = new Map<string, StrengthResult>();
      const weak: PasswordIssue[] = [];
      for (const entry of entries) {
        const result = analyzeStrength(entry.password);
        strengthMap.set(entry.id, result);
        if (result.score < 50) {
          weak.push({
            ...toWatchtowerEntryRef(entry),
            severity: result.score < 25 ? "high" : "medium",
            details: `entropy:${result.entropy}`,
          });
        }
      }

      // Age check (>OLD_THRESHOLD_DAYS days)
      const now = Date.now();
      const old: PasswordIssue[] = [];
      for (const entry of entries) {
        const updatedAt = new Date(entry.updatedAt).getTime();
        const days = Math.floor((now - updatedAt) / (24 * 60 * 60 * 1000));
        if (days > OLD_THRESHOLD_DAYS) {
          old.push({
            ...toWatchtowerEntryRef(entry),
            severity: days > 180 ? "medium" : "low",
            details: `days:${days}`,
          });
        }
      }

      // Unsecured URL detection (HTTP instead of HTTPS)
      const unsecured: PasswordIssue[] = [];
      for (const entry of entries) {
        if (entry.url && entry.url.startsWith("http://")) {
          unsecured.push({
            ...toWatchtowerEntryRef(entry),
            severity: "medium",
            details: `url:${entry.url}`,
          });
        }
      }

      // Duplicate detection: same hostname + username
      const duplicateMap = new Map<string, DecryptedEntry[]>();
      for (const entry of entries) {
        if (!entry.url || !entry.username) continue;
        const hostname = normalizeHostname(entry.url);
        if (!hostname) continue;
        const key = `${hostname}\0${entry.username.toLowerCase()}`;
        const group = duplicateMap.get(key) ?? [];
        group.push(entry);
        duplicateMap.set(key, group);
      }

      const duplicate: DuplicateGroup[] = [];
      for (const [key, group] of duplicateMap) {
        if (group.length < 2) continue;
        const [hostname, username] = key.split("\0");
        duplicate.push({
          hostname, username,
          entries: group.map(toWatchtowerEntryRef),
        });
      }

      // Expiration detection (date-only comparison to avoid timezone issues)
      const todayDate = new Date(now);
      const todayStr = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, "0")}-${String(todayDate.getDate()).padStart(2, "0")}`;
      const thresholdDate = new Date(now + EXPIRING_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
      const thresholdStr = `${thresholdDate.getFullYear()}-${String(thresholdDate.getMonth() + 1).padStart(2, "0")}-${String(thresholdDate.getDate()).padStart(2, "0")}`;
      const expiring: PasswordIssue[] = [];
      for (const entry of entries) {
        if (!entry.expiresAt) continue;
        const expiresDate = entry.expiresAt.split("T")[0];
        if (expiresDate > thresholdStr) continue;
        const isExpired = expiresDate < todayStr;
        const expiresAtMs = new Date(expiresDate).getTime();
        const todayMs = new Date(todayStr).getTime();
        const daysDiff = Math.round(Math.abs(expiresAtMs - todayMs) / (24 * 60 * 60 * 1000));
        expiring.push({
          ...toWatchtowerEntryRef(entry),
          severity: isExpired ? "medium" : "low",
          details: isExpired
            ? `expired:${daysDiff}`
            : `expires:${expiresDate}`,
        });
      }

      // Step 3: HIBP breach check (rate-limited)
      setProgress({ current: 3, total: 4, step: "hibp" });
      const breached: PasswordIssue[] = [];
      // Deduplicate passwords to avoid redundant HIBP calls
      const uniquePasswords = new Map<string, DecryptedEntry[]>();
      for (const entry of entries) {
        const group = uniquePasswords.get(entry.password) ?? [];
        group.push(entry);
        uniquePasswords.set(entry.password, group);
      }

      let hibpIndex = 0;
      const hibpTotal = uniquePasswords.size;
      for (const [password, associatedEntries] of uniquePasswords) {
        hibpIndex++;
        setProgress({
          current: 3,
          total: 4,
          step: `hibp:${hibpIndex}/${hibpTotal}`,
        });

        const result = await checkHIBP(password);
        if (result.breached) {
          for (const entry of associatedEntries) {
            breached.push({
              ...toWatchtowerEntryRef(entry),
              severity: "critical",
              details: `count:${result.count}`,
            });
          }
        }

        // Rate limit: 1.5s between HIBP requests
        if (hibpIndex < hibpTotal) await delay(1500);
      }

      // Calculate overall score
      const overallScore = calculateScore(
        entries.length,
        breached.length,
        weak.length,
        reused.reduce((sum, g) => sum + g.entries.length, 0),
        old.length,
        duplicate.reduce((sum, g) => sum + g.entries.length, 0),
        unsecured.length
      );

      setReport({
        totalPasswords: entries.length,
        overallScore,
        breached,
        weak,
        reused,
        old,
        unsecured,
        duplicate,
        expiring,
        analyzedAt: new Date(),
      });
    } catch {
      // Analysis failed silently
    } finally {
      setLoading(false);
    }
  }, [scope, encryptionKey, userId, loading, cooldownRemainingMs, teamVault]);

  // ── Auto-monitor state ──

  const [autoMonitorEnabled, setAutoMonitorEnabledState] = useState(() => {
    try {
      return window.localStorage.getItem(LS_AUTO_MONITOR_ENABLED) === "true";
    } catch {
      return false;
    }
  });

  const [lastBreachCheckAt, setLastBreachCheckAt] = useState<number | null>(() => {
    try {
      const stored = window.localStorage.getItem(LS_LAST_BREACH_CHECK_AT);
      if (!stored) return null;
      const parsed = Number(stored);
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  });

  const setAutoMonitorEnabled = useCallback((enabled: boolean) => {
    setAutoMonitorEnabledState(enabled);
    try {
      window.localStorage.setItem(LS_AUTO_MONITOR_ENABLED, String(enabled));
    } catch {
      // localStorage unavailable
    }
  }, []);

  // Keep analyze in a ref so the auto-check effect doesn't re-run
  // when analyze is recreated (e.g. cooldown updates).
  const analyzeRef = useRef(analyze);
  useEffect(() => {
    analyzeRef.current = analyze;
  }, [analyze]);

  // Auto-check on vault unlock (encryptionKey changes).
  // Only runs for personal scope — team auto-monitor is not supported yet.
  useEffect(() => {
    if (scope.type !== "personal") return;
    if (!encryptionKey) return;

    const doAutoCheck = shouldAutoCheck({
      lastCheckAt: lastBreachCheckAt,
      now: Date.now(),
      enabled: autoMonitorEnabled,
      vaultUnlocked: true,
    });

    if (!doAutoCheck) return;

    let isMounted = true;

    // Run analyze via ref to avoid dependency on analyze itself
    void (async () => {
      await analyzeRef.current({ skipRateLimit: false });

      if (!isMounted) return;

      const checkTimestamp = Date.now();
      setLastBreachCheckAt(checkTimestamp);
      try {
        window.localStorage.setItem(LS_LAST_BREACH_CHECK_AT, String(checkTimestamp));
      } catch {
        // localStorage unavailable
      }
    })();

    return () => {
      isMounted = false;
    };
    // Only re-evaluate when encryptionKey changes (vault unlock/lock).
    // autoMonitorEnabled and lastBreachCheckAt are read from their
    // current values at the time of the effect, not as reactive deps,
    // to prevent re-triggering on every state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encryptionKey, scope.type]);

  // After analysis completes, check for new breaches and send alert.
  useEffect(() => {
    if (!report) return;

    const lsKey = scope.type === "team"
      ? `${LS_LAST_KNOWN_BREACH_COUNT}:${scope.teamId}`
      : LS_LAST_KNOWN_BREACH_COUNT;

    const currentBreachCount = report.breached.length;
    let lastKnown = 0;
    try {
      const stored = window.localStorage.getItem(lsKey);
      if (stored) lastKnown = Number(stored) || 0;
    } catch {
      // localStorage unavailable
    }

    // Always update lastKnownBreachCount with current value
    try {
      window.localStorage.setItem(lsKey, String(currentBreachCount));
    } catch {
      // localStorage unavailable
    }

    if (hasNewBreaches(currentBreachCount, lastKnown)) {
      const newBreachCount = currentBreachCount - lastKnown;
      const payload: Record<string, unknown> = { newBreachCount };
      if (scope.type === "team") payload.teamId = scope.teamId;
      // Fire alert API — fire-and-forget
      void fetchApi(API_PATH.WATCHTOWER_ALERT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {
        // Alert send failure should not affect UI
      });
    }
  }, [report, scope]);

  return {
    report,
    loading,
    progress,
    analyze,
    canAnalyze,
    cooldownRemainingMs,
    nextAllowedAt,
    unavailableReason,
    autoMonitorEnabled,
    setAutoMonitorEnabled,
    lastBreachCheckAt,
  };
}

// ─── Helpers ────────────────────────────────────────────────

function normalizeHostname(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  } catch {
    return null;
  }
}

async function fetchWatchtowerEntries({
  scope,
  encryptionKey,
  teamEncryptionKey,
  userId,
  getTeamEncryptionKey,
}: {
  scope: WatchtowerScope;
  encryptionKey?: CryptoKey;
  teamEncryptionKey?: CryptoKey;
  userId?: string;
  getTeamEncryptionKey?: (teamId: string) => Promise<CryptoKey | null>;
}): Promise<FetchWatchtowerEntriesResult> {
  if (scope.type === "team") {
    if (!getTeamEncryptionKey) {
      return { status: "unavailable", reason: "teamKeyUnavailable" };
    }
    return fetchTeamWatchtowerEntries({
      teamId: scope.teamId,
      teamEncryptionKey,
      getTeamEncryptionKey,
    });
  }

  return {
    status: "ok",
    entries: await fetchPersonalWatchtowerEntries({
      encryptionKey,
      userId,
    }),
  };
}

async function fetchPersonalWatchtowerEntries({
  encryptionKey,
  userId,
}: {
  encryptionKey?: CryptoKey;
  userId?: string;
}): Promise<DecryptedEntry[]> {
  if (!encryptionKey) return [];
  const res = await fetchApi(`${API_PATH.PASSWORDS}?include=blob`);
  if (!res.ok) throw new Error("Failed to fetch passwords");
  const rawEntries = await res.json();
  const entries: DecryptedEntry[] = [];

  for (const raw of rawEntries) {
    if (!raw.encryptedBlob) continue;
    if (raw.entryType && raw.entryType !== ENTRY_TYPE.LOGIN) continue;
    try {
      const aad = raw.aadVersion >= 1 && userId
        ? buildPersonalEntryAAD(userId, raw.id)
        : undefined;
      const plaintext = await decryptData(
        raw.encryptedBlob as EncryptedData,
        encryptionKey,
        aad,
      );
      const parsed = JSON.parse(plaintext);
      entries.push({
        id: raw.id,
        title: parsed.title,
        username: parsed.username,
        password: parsed.password,
        url: parsed.url ?? null,
        updatedAt: raw.updatedAt,
        expiresAt: raw.expiresAt ?? null,
        scope: "personal",
      });
    } catch {
      // Skip entries that fail to decrypt
    }
  }

  return entries;
}

async function fetchTeamWatchtowerEntries({
  teamId,
  teamEncryptionKey,
  getTeamEncryptionKey,
}: {
  teamId: string;
  teamEncryptionKey?: CryptoKey;
  getTeamEncryptionKey: (teamId: string) => Promise<CryptoKey | null>;
}): Promise<FetchWatchtowerEntriesResult> {
  const entries: DecryptedEntry[] = [];

  const teamKey = teamEncryptionKey ?? await getTeamEncryptionKey(teamId);
  if (!teamKey) {
    return { status: "unavailable", reason: "teamKeyUnavailable" };
  }

  const listRes = await fetchApi(
    `${apiPath.teamPasswords(teamId)}?type=${ENTRY_TYPE.LOGIN}&include=blob`,
  );
  if (!listRes.ok) throw new Error("Failed to fetch team passwords");
  const listedEntries = await listRes.json();
  if (!Array.isArray(listedEntries) || listedEntries.length === 0) {
    return { status: "ok", entries };
  }

  for (const raw of listedEntries) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string") continue;
    try {
      if (
        typeof raw.encryptedBlob !== "string" ||
        typeof raw.blobIv !== "string" ||
        typeof raw.blobAuthTag !== "string"
      ) {
        continue;
      }
      const aad = buildTeamEntryAAD(teamId, raw.id, "blob");
      const plaintext = await decryptData(
        {
          ciphertext: raw.encryptedBlob,
          iv: raw.blobIv,
          authTag: raw.blobAuthTag,
        },
        teamKey,
        aad,
      );
      const parsed = JSON.parse(plaintext);
      entries.push({
        id: raw.id,
        title: parsed.title,
        username: parsed.username ?? null,
        password: parsed.password,
        url: parsed.url ?? null,
        updatedAt: raw.updatedAt,
        expiresAt: raw.expiresAt ?? null,
        scope: "team",
        teamId,
      });
    } catch {
      // Skip team entries that fail to decrypt
    }
  }

  return { status: "ok", entries };
}

// ─── Score Calculation ───────────────────────────────────────

function calculateScore(
  total: number,
  breachedCount: number,
  weakCount: number,
  reusedCount: number,
  oldCount: number,
  duplicateCount: number,
  unsecuredCount: number
): number {
  if (total === 0) return 100;

  // Weighted scoring: breach(40%), strength(25%), uniqueness(20%), freshness(5%), duplicate(5%), security(5%)
  const breachScore = ((total - breachedCount) / total) * 40;
  const strengthScore = ((total - weakCount) / total) * 25;
  const uniqueScore = ((total - reusedCount) / total) * 20;
  const freshnessScore = ((total - oldCount) / total) * 5;
  const duplicateScore = ((total - duplicateCount) / total) * 5;
  const securityScore = ((total - unsecuredCount) / total) * 5;

  return Math.round(
    Math.max(0, Math.min(100, breachScore + strengthScore + uniqueScore + freshnessScore + duplicateScore + securityScore))
  );
}
