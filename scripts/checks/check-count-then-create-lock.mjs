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
 * of: (a) a `.count(` or `.aggregate(` call, (b) a cap comparison against a MAX_*
 * / *_LIMIT* constant (`>= MAX_…`, `> …_LIMIT`, etc.), and (c) a `.create(` call.
 * Every such file MUST also contain `pg_advisory_xact_lock`, OR appear in
 * SOFT_CAP_EXEMPTIONS with a reviewed reason.
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

// A cap comparison: a >= or > against a MAX_* / *_LIMIT* / LIMIT_PER_* constant,
// or a bare numeric cap next to such a name. Deliberately excludes length/size
// guards (MAX_LENGTH, MAX_FILE_SIZE, MAX_BYTES, MAX_DAYS, …) which are validation
// bounds, not count caps — those never pair a count() with a create() on a cap.
const CAP_COMPARISON_RE =
  />=?\s*(MAX_(?!LENGTH|FILE_SIZE|BYTES|JSON|DAYS|AGE|DEPTH|EXPIRY|EXPIRES|DIMENSION|IMPORT_FOLDERS|CIDRS|BULK|ATTEMPTS|CONCURRENT_SESSIONS_(?:MIN|MAX))[A-Z_]*|[A-Z_]+_LIMIT(?:_PER_[A-Z]+)?|TOKEN_LIMIT[A-Z_]*)\b/;
const COUNT_RE = /\.(count|aggregate)\s*\(/;
const CREATE_RE = /\.create\s*\(/;
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
