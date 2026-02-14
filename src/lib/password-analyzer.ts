// ─── Password Security Analyzer ──────────────────────────────
// All analysis runs client-side (E2E encrypted vault).
// HIBP uses k-Anonymity: only SHA-1 prefix (5 chars) is sent.

export interface StrengthResult {
  score: number; // 0-100
  entropy: number;
  hasUppercase: boolean;
  hasLowercase: boolean;
  hasNumbers: boolean;
  hasSymbols: boolean;
  patterns: string[];
}

// ─── Entropy Calculation ─────────────────────────────────────

function getCharsetSize(password: string): number {
  let size = 0;
  if (/[a-z]/.test(password)) size += 26;
  if (/[A-Z]/.test(password)) size += 26;
  if (/[0-9]/.test(password)) size += 10;
  if (/[^a-zA-Z0-9]/.test(password)) size += 33;
  return size || 1;
}

export function calculateEntropy(password: string): number {
  if (!password) return 0;
  const charsetSize = getCharsetSize(password);
  return Math.log2(charsetSize) * password.length;
}

// ─── Pattern Detection ───────────────────────────────────────

const KEYBOARD_ROWS = [
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
  "1234567890",
];

const COMMON_WORDS = [
  "password",
  "passwd",
  "qwerty",
  "abc123",
  "letmein",
  "admin",
  "welcome",
  "monkey",
  "dragon",
  "master",
  "login",
  "princess",
  "football",
  "shadow",
  "sunshine",
  "trustno1",
  "iloveyou",
];

function hasSequentialChars(password: string, minLen = 3): boolean {
  const lower = password.toLowerCase();
  for (let i = 0; i <= lower.length - minLen; i++) {
    let ascending = true;
    let descending = true;
    for (let j = 1; j < minLen; j++) {
      if (lower.charCodeAt(i + j) !== lower.charCodeAt(i + j - 1) + 1)
        ascending = false;
      if (lower.charCodeAt(i + j) !== lower.charCodeAt(i + j - 1) - 1)
        descending = false;
    }
    if (ascending || descending) return true;
  }
  return false;
}

function hasRepeatedChars(password: string, minLen = 3): boolean {
  for (let i = 0; i <= password.length - minLen; i++) {
    const char = password[i];
    let count = 1;
    while (i + count < password.length && password[i + count] === char) count++;
    if (count >= minLen) return true;
  }
  return false;
}

function hasKeyboardPattern(password: string, minLen = 4): boolean {
  const lower = password.toLowerCase();
  for (const row of KEYBOARD_ROWS) {
    for (let i = 0; i <= row.length - minLen; i++) {
      const segment = row.slice(i, i + minLen);
      const reversed = segment.split("").reverse().join("");
      if (lower.includes(segment) || lower.includes(reversed)) return true;
    }
  }
  return false;
}

function hasCommonWord(password: string): string | null {
  const lower = password.toLowerCase();
  for (const word of COMMON_WORDS) {
    if (lower.includes(word)) return word;
  }
  return null;
}

export function detectPatterns(password: string): string[] {
  const patterns: string[] = [];
  if (hasSequentialChars(password)) patterns.push("sequential");
  if (hasRepeatedChars(password)) patterns.push("repeated");
  if (hasKeyboardPattern(password)) patterns.push("keyboard");
  const common = hasCommonWord(password);
  if (common) patterns.push(`common:${common}`);
  return patterns;
}

// ─── Strength Analysis ───────────────────────────────────────

export function analyzeStrength(password: string): StrengthResult {
  const entropy = calculateEntropy(password);
  const patterns = detectPatterns(password);
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasNumbers = /[0-9]/.test(password);
  const hasSymbols = /[^a-zA-Z0-9]/.test(password);

  // Base score from entropy (0-70 range)
  let score = Math.min(70, (entropy / 80) * 70);

  // Character diversity bonus (0-20 range)
  const classCount = [hasUppercase, hasLowercase, hasNumbers, hasSymbols].filter(
    Boolean
  ).length;
  score += classCount * 5;

  // Length bonus (0-10 range)
  score += Math.min(10, (password.length / 20) * 10);

  // Pattern penalties
  if (patterns.length > 0) score *= 0.7;
  if (patterns.some((p) => p.startsWith("common:"))) score *= 0.5;

  // Short passwords are always weak
  if (password.length < 8) score = Math.min(score, 20);

  return {
    score: Math.round(Math.max(0, Math.min(100, score))),
    entropy: Math.round(entropy * 10) / 10,
    hasUppercase,
    hasLowercase,
    hasNumbers,
    hasSymbols,
    patterns,
  };
}

// ─── HIBP k-Anonymity Check ─────────────────────────────────

async function sha1Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function checkHIBP(
  password: string
): Promise<{ breached: boolean; count: number }> {
  const hash = (await sha1Hex(password)).toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  try {
    const res = await fetch(`${API_PATH.WATCHTOWER_HIBP}?prefix=${prefix}`);
    if (!res.ok) return { breached: false, count: 0 };

    const text = await res.text();
    for (const line of text.split("\n")) {
      const [hashSuffix, countStr] = line.trim().split(":");
      if (hashSuffix === suffix) {
        return { breached: true, count: parseInt(countStr, 10) };
      }
    }
    return { breached: false, count: 0 };
  } catch {
    return { breached: false, count: 0 };
  }
}

// ─── Utility: delay for rate limiting ────────────────────────

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
import { API_PATH } from "@/lib/constants";
