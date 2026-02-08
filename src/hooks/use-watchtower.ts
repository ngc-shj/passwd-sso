"use client";

import { useState, useCallback } from "react";
import { useVault } from "@/lib/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
import {
  analyzeStrength,
  checkHIBP,
  delay,
  type StrengthResult,
} from "@/lib/password-analyzer";

// ─── Constants ──────────────────────────────────────────────

export const OLD_THRESHOLD_DAYS = 90;

// ─── Types ───────────────────────────────────────────────────

export type IssueSeverity = "critical" | "high" | "medium" | "low";

export interface PasswordIssue {
  id: string;
  title: string;
  username: string | null;
  severity: IssueSeverity;
  details: string;
}

export interface ReusedGroup {
  entries: { id: string; title: string; username: string | null }[];
}

export interface WatchtowerReport {
  totalPasswords: number;
  overallScore: number;
  breached: PasswordIssue[];
  weak: PasswordIssue[];
  reused: ReusedGroup[];
  old: PasswordIssue[];
  unsecured: PasswordIssue[];
  analyzedAt: Date;
}

export interface WatchtowerProgress {
  current: number;
  total: number;
  step: string;
}

interface DecryptedEntry {
  id: string;
  title: string;
  username: string | null;
  password: string;
  url: string | null;
  updatedAt: string;
}

// ─── Hook ────────────────────────────────────────────────────

export function useWatchtower() {
  const { encryptionKey } = useVault();
  const [report, setReport] = useState<WatchtowerReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<WatchtowerProgress>({
    current: 0,
    total: 0,
    step: "",
  });

  const analyze = useCallback(async () => {
    if (!encryptionKey) return;
    setLoading(true);
    setReport(null);

    try {
      // Step 1: Fetch all encrypted passwords (including blobs)
      setProgress({ current: 0, total: 4, step: "fetching" });
      const res = await fetch("/api/passwords?include=blob");
      if (!res.ok) throw new Error("Failed to fetch passwords");
      const rawEntries = await res.json();

      if (rawEntries.length === 0) {
        setReport({
          totalPasswords: 0,
          overallScore: 100,
          breached: [],
          weak: [],
          reused: [],
          old: [],
          unsecured: [],
          analyzedAt: new Date(),
        });
        return;
      }

      // Step 2: Decrypt all entries
      setProgress({ current: 1, total: 4, step: "decrypting" });
      const entries: DecryptedEntry[] = [];
      for (const raw of rawEntries) {
        if (!raw.encryptedBlob) continue;
        try {
          const plaintext = await decryptData(
            raw.encryptedBlob as EncryptedData,
            encryptionKey
          );
          const parsed = JSON.parse(plaintext);
          entries.push({
            id: raw.id,
            title: parsed.title,
            username: parsed.username,
            password: parsed.password,
            url: parsed.url ?? null,
            updatedAt: raw.updatedAt,
          });
        } catch {
          // Skip entries that fail to decrypt
        }
      }

      // Step 3: Local analysis (duplicates, strength, age)
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
            entries: group.map((e) => ({
              id: e.id,
              title: e.title,
              username: e.username,
            })),
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
            id: entry.id,
            title: entry.title,
            username: entry.username,
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
            id: entry.id,
            title: entry.title,
            username: entry.username,
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
            id: entry.id,
            title: entry.title,
            username: entry.username,
            severity: "medium",
            details: `url:${entry.url}`,
          });
        }
      }

      // Step 4: HIBP breach check (rate-limited)
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
              id: entry.id,
              title: entry.title,
              username: entry.username,
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
        analyzedAt: new Date(),
      });
    } catch {
      // Analysis failed silently
    } finally {
      setLoading(false);
    }
  }, [encryptionKey]);

  return { report, loading, progress, analyze };
}

// ─── Score Calculation ───────────────────────────────────────

function calculateScore(
  total: number,
  breachedCount: number,
  weakCount: number,
  reusedCount: number,
  oldCount: number,
  unsecuredCount: number
): number {
  if (total === 0) return 100;

  // Weighted scoring: breach(40%), strength(25%), uniqueness(20%), freshness(10%), security(5%)
  const breachScore = ((total - breachedCount) / total) * 40;
  const strengthScore = ((total - weakCount) / total) * 25;
  const uniqueScore = ((total - reusedCount) / total) * 20;
  const freshnessScore = ((total - oldCount) / total) * 10;
  const securityScore = ((total - unsecuredCount) / total) * 5;

  return Math.round(
    Math.max(0, Math.min(100, breachScore + strengthScore + uniqueScore + freshnessScore + securityScore))
  );
}
