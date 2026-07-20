#!/usr/bin/env node
/**
 * CI guard: null-tenant fail-open enforcement class — completeness manifest.
 *
 * An enforcement decision that reads a tenant security policy via
 * `tenant.findUnique({ select: { <enforcement field> } })` (or the relation join
 * `tenant: { select: … }`) and, on a null row, falls back to the LENIENT side
 * silently BYPASSES that control. tenantId always comes from a server-trusted,
 * FK-RESTRICT-backed source (session / token row / the non-null `User.tenantId`),
 * so a null row on a successful query is data corruption — NOT "no policy
 * configured" (an unset policy is a REAL row with a null/empty field). The safe
 * responses are to THROW (fail closed → caller denies) or return a RESTRICTIVE
 * default (still enforces the control). Defaulting to the permissive side is the
 * fail-open bug. See PR #685 (derivePasskeyState) and the
 * null-tenant-fail-open plan.
 *
 * This class was enumerated by hand and grew 4 → 5 → 7 during review (the R42
 * accretion signature: a member-set that grows by accretion was never derived
 * from the true primitive, so the next silently-missed member is likely still
 * unwritten). Because the class cannot be mechanically split into
 * throw / fail-safe-default / display-echo by grep alone, this guard pins
 * COMPLETENESS: it enumerates every enforcement-field tenant read from the
 * defining primitive and fails when the live set diverges from the reviewed
 * MANIFEST below — a NEW site (unclassified member → must be reviewed and given
 * a disposition) or a VANISHED site (stale manifest entry → remove it). The
 * per-site fail-closed behavior is pinned by the mutation-verified unit tests;
 * this guard guarantees no new member ships unreviewed.
 *
 * Detection is lexical-with-context (no AST dependency — cheap, runs in the
 * static-checks job): a file is an "enforcement tenant read" when it contains a
 * `tenant.findUnique(` or `tenant: { select:` whose surrounding source names at
 * least one ENFORCEMENT field. Every such file MUST appear in MANIFEST with a
 * disposition; every MANIFEST entry MUST still match.
 *
 * Exit 0 = OK. Exit 1 = the live enforcement-read set diverges from MANIFEST.
 *
 * Env: NTFC_CHECK_ROOT overrides the repo root (used by the guard self-test to
 * point the scan at a throwaway fixture tree — see the mutation-verification in
 * the null-tenant-fail-open code review).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, extname, relative } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ROOT = process.env.NTFC_CHECK_ROOT ?? REPO_ROOT;
const SCAN_DIRS = ["src/app/api", "src/lib", "src/auth.ts"];

// Every enforcement-field tenant read in the codebase, with its reviewed
// disposition. Adding a NEW enforcement read requires a manifest entry (choose
// the right disposition and confirm the code matches it); removing one requires
// deleting its entry. Dispositions:
//   "throw"           — fails closed on null row via `if (!tenant) throw` (the
//                       corruption case denies).
//   "failsafe-default"— null/error path returns a RESTRICTIVE default that still
//                       enforces the control (never the permissive side).
//   "display-exempt"  — NOT an access decision on a subject: config-write
//                       validation or a client-display echo in a response body.
const MANIFEST = new Map([
  // ── fail-closed via throw (fixed in this class) ────────────────────────────
  ["src/lib/auth/policy/access-restriction.ts", "throw"],
  ["src/lib/auth/policy/passkey-enforcement.ts", "throw"],
  ["src/lib/auth/session/auth-adapter.ts", "throw"],
  ["src/lib/auth/tokens/extension-token.ts", "throw"],
  ["src/app/api/extension/token/refresh/route.ts", "throw"],
  ["src/app/api/webauthn/register/verify/route.ts", "throw"],
  ["src/lib/team/team-policy.ts", "throw"],
  ["src/auth.ts", "throw"],
  // ── fail-safe restrictive default (verified — never permissive) ────────────
  ["src/lib/auth/policy/account-lockout.ts", "failsafe-default"],
  ["src/lib/auth/session/session-timeout.ts", "failsafe-default"],
  // ── display / config-write echo (not an access decision) ───────────────────
  ["src/app/api/tenant/policy/route.ts", "display-exempt"],
  ["src/app/api/teams/[teamId]/policy/route.ts", "display-exempt"],
  ["src/app/api/vault/status/route.ts", "display-exempt"],
  ["src/app/api/vault/unlock/data/route.ts", "display-exempt"],
  ["src/app/api/user/passkey-status/route.ts", "display-exempt"],
  ["src/app/api/sessions/route.ts", "display-exempt"],
]);

// Enforcement fields whose null-row lenient fallback bypasses a control.
const ENFORCEMENT_FIELD_RE =
  /\b(allowedCidrs|tailscaleEnabled|tailscaleTailnet|requirePasskey|requirePasskeyEnabledAt|passkeyGracePeriodDays|requireMinPinLength|lockoutThreshold[123]|lockoutDuration[123]Minutes|extensionTokenIdleTimeoutMinutes|extensionTokenAbsoluteTimeoutMinutes|maxConcurrentSessions|sessionIdleTimeoutMinutes|sessionAbsoluteTimeoutMinutes|vaultAutoLockMinutes)\b/;

// A tenant policy read: direct findUnique or the relation-join select.
const TENANT_READ_RE = /tenant\.findUnique\s*\(|tenant:\s*\{\s*select:/;

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
    else if (
      e.isFile() &&
      (extname(e.name) === ".ts" || extname(e.name) === ".tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

const targets = SCAN_DIRS.flatMap((d) => {
  const full = join(ROOT, d);
  return d.endsWith(".ts") ? [full] : walk(full);
});

const liveReads = new Set();
for (const file of targets) {
  if (file.includes(".test.") || file.includes("__tests__")) continue;
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (TENANT_READ_RE.test(src) && ENFORCEMENT_FIELD_RE.test(src)) {
    // relative() normalizes away any trailing slash on ROOT.
    liveReads.add(relative(ROOT, file));
  }
}

const unlisted = [...liveReads].filter((r) => !MANIFEST.has(r)).sort();
const stale = [...MANIFEST.keys()].filter((r) => !liveReads.has(r)).sort();

let failed = false;

if (unlisted.length > 0) {
  failed = true;
  console.error(
    "null-tenant fail-open: NEW enforcement tenant read(s) not in the MANIFEST:",
  );
  console.error(
    "Classify each in scripts/checks/check-null-tenant-fail-closed.mjs — the null-row",
  );
  console.error(
    "path must THROW or return a RESTRICTIVE default (never the permissive side), or be",
  );
  console.error("a display/config-write echo. Add the reviewed disposition.");
  console.error("");
  for (const v of unlisted) console.error(`  ${v}`);
}

if (stale.length > 0) {
  failed = true;
  if (unlisted.length > 0) console.error("");
  console.error(
    "MANIFEST entries that no longer read an enforcement tenant field (stale — remove them):",
  );
  console.error("");
  for (const s of stale) console.error(`  ${s}`);
}

if (failed) process.exit(1);
console.log(
  `check-null-tenant-fail-closed: OK (${liveReads.size} enforcement reads, all classified)`,
);
