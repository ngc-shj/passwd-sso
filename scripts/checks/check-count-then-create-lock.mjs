#!/usr/bin/env node
/**
 * CI guard: every per-scope "count/aggregate → check cap → create" site under an
 * RLS wrapper MUST serialize with a `pg_advisory_xact_lock` (else two concurrent
 * requests both read count < cap and both create, exceeding the cap — a TOCTOU
 * race). See the bypass-rls-tx-callback-form plan: this class expanded from 1 to
 * 17 sites during review because it was enumerated by hand; this guard mechanizes
 * completeness so a NEW cap-then-create site can't ship without a lock (or an
 * explicit, reviewed soft-cap exemption).
 *
 * Detection is lexical-with-context (no AST dependency needed — cheap, runs in
 * the static-checks job): a file is a "cap-then-create site" when it contains ALL
 * of: (a) a per-scope READ — `.count(`, `.aggregate(`, or `.findMany(` (the
 * "evict-oldest" family reads with findMany then compares `.length`), (b) a cap
 * comparison — either a MAX_* / *_LIMIT* / *_TOTAL_BYTES constant threshold, a
 * `.length … > /`>=` overflow check, or a `maxConcurrentSessions`/`maxSessions`
 * dynamic cap, and (c) a WRITE that bumps the counted set — `.create(`,
 * `.createMany(`, `.upsert(`, or a claim-style `.updateMany(` (flips a scoping FK
 * on an existing row, e.g. DCR claim `tenantId: null → tenantId`). Every such file
 * MUST also contain `pg_advisory_xact_lock`, OR appear in SOFT_CAP_EXEMPTIONS.
 *
 * The read/cap/write alternations are deliberately broad because the class's real
 * defining primitive is "read a per-scope table → gate on a cap → write it", NOT
 * the `.count()+MAX_` spelling. Keying on that spelling let bridge-code / token /
 * session caps (findMany().length), the byte-quota send cap (_TOTAL_BYTES), and
 * the DCR-consent claim (updateMany, no .create) ship or mutate without the guard
 * seeing them. See the triangulate review pr637-toctou-cap-*.
 *
 * This is a floor, not a proof of correctness — it cannot verify the lock is in
 * the SAME tx as the count+create (that's review-enforced, and pinned by the
 * per-site mutation-kill unit assertions). It DOES catch the common regression:
 * a new cap enforcer added with no lock at all.
 *
 * Exit 0 = OK. Exit 1 = a cap-then-create site lacks a lock and isn't exempt.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ROOT = process.env.CTC_CHECK_ROOT ?? REPO_ROOT;
const SCAN_DIRS = ["src/app/api", "src/lib"];

// Files that legitimately count-then-create WITHOUT an advisory lock, with the
// reviewed reason. Keep this list tight — every entry is a conscious decision
// that the cap may overshoot (soft cap) or the race is otherwise impossible.
const SOFT_CAP_EXEMPTIONS = new Map([
  [
    "src/lib/quota/resource-quotas.ts",
    "documented pre-1.0 soft-cap: COUNT→check→INSERT is not atomic and may overshoot by N; hard-cap deferred (see file header)",
  ],
]);

// A cap comparison. Three shapes are accepted (the class uses all three):
//  1. A >= / > against a named UPPER_SNAKE cap constant: MAX_* / *_LIMIT* /
//     *_TOTAL_BYTES. Length/size VALIDATION bounds (MAX_LENGTH, MAX_FILE_SIZE,
//     MAX_BYTES, MAX_DAYS, …) are excluded — they never gate a table count.
//     *_TOTAL_BYTES is the one _BYTES form that IS a count cap (a byte-quota over
//     an aggregated table, e.g. SEND_MAX_ACTIVE_TOTAL_BYTES), so it is allowed
//     while the generic _BYTES / _FILE_SIZE validation bounds stay excluded.
//  2. A `.length`-based overflow check in the findMany().length "evict-oldest"
//     family. Matched narrowly as `<name>.length + N - CAP_CONSTANT` (the exact
//     shape used by the bridge-code / extension-token / mobile-token caps) so a
//     bare `xs.length > 0` / `> limit` / `> 20` pagination or presence check is
//     NOT mistaken for a cap.
//  3. A dynamic per-tenant session cap held in a lowercase var
//     (maxSessions / maxConcurrentSessions), which matches no naming convention.
// Excluded MAX_ forms are not per-scope DB caps: validation length/size bounds
// (LENGTH, FILE_SIZE, BYTES, DIMENSION, …), time/interval constants (…_THROTTLE_MS
// and other THROTTLE intervals, AGE, DAYS, EXPIRY/EXPIRES), traversal bounds
// (DEPTH), and the in-memory Map size cap (CACHE_ENTRIES) used by per-process
// throttle caches. *_TOTAL_BYTES is re-admitted below — it IS a byte-quota cap.
const CAP_NAMED_RE =
  />=?\s*(MAX_(?!LENGTH|FILE_SIZE|BYTES|JSON|DAYS|AGE|DEPTH|EXPIRY|EXPIRES|DIMENSION|IMPORT_FOLDERS|CIDRS|BULK|ATTEMPTS|CACHE_ENTRIES|[A-Z_]*THROTTLE[A-Z_]*|CONCURRENT_SESSIONS_(?:MIN|MAX))[A-Z_]*|[A-Z_]+_TOTAL_BYTES|[A-Z_]+_LIMIT(?:_PER_[A-Z]+)?|TOKEN_LIMIT[A-Z_]*)\b/;
// `active.length + 1 - BRIDGE_CODE_MAX_ACTIVE` — length, then arithmetic against
// an UPPER_SNAKE cap constant. Anchored on the `- CONSTANT` so presence checks
// (`xs.length > 0`) and numeric-literal bounds (`all.length > 20`) do not match.
const CAP_LENGTH_OVERFLOW_RE = /\.length\s*[-+][^;\n]*?[-+]\s*[A-Z][A-Z0-9_]*[A-Z0-9]\b/;
const CAP_DYNAMIC_SESSION_RE = /\.length\s*>=?\s*maxSessions\b|>=?\s*maxConcurrentSessions\b/;
const CAP_COMPARISON_RE = new RegExp(
  `${CAP_NAMED_RE.source}|${CAP_LENGTH_OVERFLOW_RE.source}|${CAP_DYNAMIC_SESSION_RE.source}`,
);
// A per-scope read that establishes the current count.
const COUNT_RE = /\.(count|aggregate|findMany)\s*\(/;
// A write that bumps the counted set: a plain create, or a claim/CAS updateMany
// (flips a scoping FK on an existing row — the DCR-consent claim increments a
// tenant's client count with no `.create` at all), or upsert.
const CREATE_RE = /\.(create|createMany|updateMany|upsert)\s*\(/;
const LOCK_RE = /pg_advisory_xact_lock|advisoryXactLock\s*\(/;
const RLS_WRAPPER_RE = /with(?:Bypass|Tenant|UserTenant|TeamTenant)Rls\s*\(/;

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

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
const violations = [];
const staleExemptions = [];

for (const file of files) {
  if (file.includes(".test.") || file.includes("__tests__")) continue;
  const rel = file.slice(ROOT.length + 1);
  const src = readFileSync(file, "utf8");

  const isCapThenCreate =
    RLS_WRAPPER_RE.test(src) &&
    COUNT_RE.test(src) &&
    CREATE_RE.test(src) &&
    CAP_COMPARISON_RE.test(src);

  const exemptReason = SOFT_CAP_EXEMPTIONS.get(rel);
  if (exemptReason) {
    if (!isCapThenCreate) staleExemptions.push(rel);
    continue; // exempt sites are allowed to lack the lock
  }

  if (isCapThenCreate && !LOCK_RE.test(src)) {
    violations.push(rel);
  }
}

let failed = false;

if (violations.length > 0) {
  failed = true;
  console.error(
    "count-then-create cap site(s) missing a pg_advisory_xact_lock (TOCTOU risk):",
  );
  console.error(
    "Wrap count + cap-check + create in ONE RLS tx with a per-scope advisory lock,",
  );
  console.error(
    "or add the file to SOFT_CAP_EXEMPTIONS in this script with a reviewed reason.",
  );
  console.error("");
  for (const v of violations) console.error(`  ${v}`);
}

if (staleExemptions.length > 0) {
  failed = true;
  if (violations.length > 0) console.error("");
  console.error(
    "SOFT_CAP_EXEMPTIONS entries that no longer match the cap-then-create pattern (stale — remove them):",
  );
  console.error("");
  for (const s of staleExemptions) console.error(`  ${s}`);
}

if (failed) process.exit(1);
console.log("check-count-then-create-lock: OK");
