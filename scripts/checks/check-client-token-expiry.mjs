#!/usr/bin/env node
/**
 * CI guard: every client-token (extension / iOS) row write under `src/` that
 * establishes `ExtensionToken.expiresAt` MUST compute it through
 * `computeClientTokenExpiry` (src/lib/auth/tokens/client-token-expiry.ts) —
 * the single implementation of the presence/idle/absolute cap (long-lived-
 * client-login plan §C3). A site that inlines its own
 * `now.getTime() + idleMinutes * MS_PER_MINUTE` bypasses the presence cap: the
 * row would never expire early even after the family's last server-verified
 * unlock aged out past the tenant's idle timeout.
 *
 * Detection is lexical-with-context (mirrors check-count-then-create-lock.mjs
 * — no AST dependency needed, cheap, runs in the static-checks job; comment
 * lines are not stripped, same scope as count-then-create-lock.mjs). A file
 * is a "client-token expiry site" when it contains:
 *   (a) an `extensionToken.create(` call — the schema's `expiresAt` column is
 *       NOT NULL, so every row creation site is unconditionally in scope, OR
 *   (b) an `extensionToken.update(` / `updateMany(` call whose OWN data
 *       argument writes `expiresAt` — bracket-matched per call (not file-wide)
 *       so a file that ALSO does an unrelated revoke-only update (writing only
 *       `revokedAt`) is not dragged in by that call alone.
 * Every such file MUST import `computeClientTokenExpiry`, OR be listed in
 * `scripts/checks/client-token-expiry-exemptions.txt` (`path # reason`, same
 * format as raw-sql-usage.txt) with a reviewed reason (e.g. a file that only
 * revokes but happens to also write a literal `expiresAt` sentinel). Because
 * the check is per-FILE, `mobile-token.ts`'s own fixed-TTL AutoFill token
 * create needs no separate exemption: the file already imports the helper for
 * its iOS issuance path (plan §C3's "exemption is per-file not per-call"
 * declared residual).
 *
 * This is a floor, not a proof of correctness: a file that imports the helper
 * but never actually calls it for a given write is not caught (review-
 * enforced, like count-then-create-lock's own limits).
 *
 * Exit 0 = OK. Exit 1 = a qualifying site lacks the import and isn't exempt,
 * or the exemptions file is malformed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ROOT = process.env.CTE_CHECK_ROOT ?? REPO_ROOT;
const SCAN_DIR = "src";
const EXEMPTIONS_PATH = process.env.CTE_EXEMPTIONS_FILE
  ? join(ROOT, process.env.CTE_EXEMPTIONS_FILE)
  : join(ROOT, "scripts/checks/client-token-expiry-exemptions.txt");

const CREATE_RE = /\bextensionToken\.create\s*\(/;
const UPDATE_RE = /\bextensionToken\.(?:update|updateMany)\s*\(/g;
const IMPORT_RE = /\bcomputeClientTokenExpiry\b/;

/**
 * Extract the full parenthesized argument text of a call, given the index of
 * its opening `(`. Bracket-matched (paren depth), string/template-literal
 * aware so a stray `)` inside a string doesn't terminate early. Mirrors the
 * span-tracking style used by check-raw-sql-usage.mjs for Unsafe call spans.
 */
export function extractCallArgs(src, openParenIdx) {
  let depth = 0;
  let inString = null;
  let out = "";
  for (let i = openParenIdx; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        i++;
        if (i < src.length) out += src[i];
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out += ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      out += ch;
      continue;
    }
    if (ch === ")") {
      depth--;
      out += ch;
      if (depth === 0) return out;
      continue;
    }
    out += ch;
  }
  return out; // unterminated (malformed source) — return what we scanned
}

/**
 * Does this file contain a client-token expiry site (see module doc)?
 */
export function isClientTokenExpirySite(src) {
  if (CREATE_RE.test(src)) return true;

  for (const m of src.matchAll(UPDATE_RE)) {
    const openParenIdx = m.index + m[0].length - 1;
    const args = extractCallArgs(src, openParenIdx);
    if (/\bexpiresAt\b/.test(args)) return true;
  }
  return false;
}

/**
 * Parse the exemptions file: `path # reason` per line, `#`-only lines and
 * blank lines skipped. Throws (fail loudly) on a line with a path but no
 * `#`-delimited reason, or an empty path/reason.
 */
export function parseExemptions(content) {
  const map = new Map();
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    const hashIdx = raw.indexOf("#");
    if (hashIdx === -1) {
      throw new Error(`malformed exemption line (missing '# reason'): ${JSON.stringify(raw)}`);
    }
    const path = raw.slice(0, hashIdx).trim();
    const reason = raw.slice(hashIdx + 1).trim();
    if (!path) {
      throw new Error(`malformed exemption line (empty path): ${JSON.stringify(raw)}`);
    }
    if (reason.length < 10) {
      throw new Error(`malformed exemption line (reason must be >=10 chars): ${JSON.stringify(raw)}`);
    }
    map.set(path, reason);
  }
  return map;
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile() && (extname(e.name) === ".ts" || extname(e.name) === ".tsx")) out.push(full);
  }
  return out;
}

function main() {
  let exemptions;
  try {
    const content = readFileSync(EXEMPTIONS_PATH, "utf8");
    exemptions = parseExemptions(content);
  } catch (e) {
    if (e.code === "ENOENT") {
      exemptions = new Map();
    } else {
      console.error(`check-client-token-expiry: ${e.message}`);
      process.exit(1);
    }
  }

  const files = walk(join(ROOT, SCAN_DIR));
  const violations = [];
  const matchedExemptions = new Set();

  for (const file of files) {
    if (file.includes(".test.") || file.includes("__tests__")) continue;
    const rel = file.slice(ROOT.length + 1);
    const src = readFileSync(file, "utf8");

    if (!isClientTokenExpirySite(src)) continue;

    if (exemptions.has(rel)) {
      matchedExemptions.add(rel);
      continue;
    }

    if (!IMPORT_RE.test(src)) {
      violations.push(rel);
    }
  }

  const staleExemptions = [...exemptions.keys()].filter((k) => !matchedExemptions.has(k));

  let failed = false;

  if (violations.length > 0) {
    failed = true;
    console.error(
      "client-token expiry site(s) missing a computeClientTokenExpiry import (presence-cap bypass risk):",
    );
    console.error(
      "Compute expiresAt through computeClientTokenExpiry (src/lib/auth/tokens/client-token-expiry.ts),",
    );
    console.error(
      "or add the file to scripts/checks/client-token-expiry-exemptions.txt with a reviewed reason.",
    );
    console.error("");
    for (const v of violations) console.error(`  ${v}`);
  }

  if (staleExemptions.length > 0) {
    failed = true;
    if (violations.length > 0) console.error("");
    console.error(
      "client-token-expiry-exemptions.txt entries that no longer match a client-token expiry site (stale — remove them):",
    );
    console.error("");
    for (const s of staleExemptions) console.error(`  ${s}`);
  }

  if (failed) process.exit(1);
  console.log("check-client-token-expiry: OK");
}

main();
