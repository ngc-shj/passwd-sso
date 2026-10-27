/**
 * Parity test for scripts/checks/route-policy-manifest.json (route-policy-sql-security
 * plan, C1).
 *
 * The manifest is a machine-readable security classification of every
 * `src/app/api/**` route file (kind, methods, Bearer-bypass surface,
 * destructive/side-effecting-GET/operator-gated flags). Two kinds of fields
 * exist:
 *   - Classifier fields (`kind`, `methods`, `bearerBypass`) are verified here
 *     by importing the REAL production functions (`classifyRoute`,
 *     `isBearerBypassRoute`) — no reimplementation, no drift possible.
 *   - Class-flag fields (`destructive`, `sideEffectingGet`, `operatorGated`)
 *     are verified by re-deriving the member-set from the same defining
 *     regexes the existing `.sh` checks use, sourced from the shared
 *     scripts/checks/route-class-patterns.json (so the .sh check and this
 *     test cannot drift apart).
 *   - Doc fields (`auth`, `handlerAuthReason`) are only checked for presence
 *     (assertion 5) — their prose accuracy is a human review concern, not a
 *     mechanical one.
 *
 * KNOWN LIMITATION (two-tier invariant, documented per plan): assertion 7
 * (side-effecting GET) mechanically detects only DIRECT write primitives in
 * GET-only route files. A GET handler that delegates a write to an imported
 * service function is not detected — the manifest field itself remains the
 * authoritative declaration; only the automated detection has this floor.
 * Multi-method files are excluded from assertion 7 entirely (writes belong to
 * their mutating handlers, not the GET branch).
 *
 * Assertion 8b requires a fail-closed rate-limit call (a real
 * createRateLimiter({ failClosedOnRedisError: true }) call, a real
 * checkRateLimitOrFail call, and the fail-closed limiter flowing into it) in
 * every `operatorGated: true` file. Assertions 6/7/8b/8c match via AST
 * (src/__tests__/proxy/ast-guards.ts) rather than lexical source text, so a
 * required call hidden in a comment / string / unused import no longer satisfies
 * a guard. If the limiter symbols are ever renamed, re-derive them with:
 *   grep -rn 'RateLimit' src/app/api/maintenance src/app/api/admin --include=route.ts
 *
 * Assertions 9-10 (session-api-passkey-gate plan, C1/I1/I2): every route
 * declares, per method, the proxy session passkey gate's outcome for a blocked
 * session cookie (`sessionPasskeyGate`; a catch-all route also lists
 * `concretePaths`). The outcome table runs every declaration through the REAL
 * handleApiAuth and getSessionInfo, so a declaration and the proxy cannot
 * disagree. `tier-b` and `own-gate` look the same at the proxy; the own-gate
 * set is pinned by the I2 snapshot here and by
 * scripts/checks/check-session-passkey-readers.mjs (each own-gate route calls
 * passkeyEnforcementBlocks).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

// The outcome table (assertion 10) runs the real handleApiAuth and the real
// getSessionInfo. Mocked: the session cache (always a miss), the tenant lookup
// (a non-null tenant), the IP restriction (allowed) and the audit write —
// nothing else on the session path. Redis is absent, so the gate's real audit
// limiter counts in memory, which _resetSessionPasskeyAuditForTests clears; a
// REDIS_URL in the environment (app-ci sets one) would otherwise carry its
// dedup keys across runs.
const { mockCheckAccessWithAudit, mockResolveUserTenantId, mockLogAuditAsync } = vi.hoisted(() => ({
  mockCheckAccessWithAudit: vi.fn(),
  mockResolveUserTenantId: vi.fn(),
  mockLogAuditAsync: vi.fn(),
}));

vi.mock("@/lib/auth/session/session-cache", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  getCachedSession: async () => null,
  setCachedSession: async () => {},
}));
vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
  validateRedisConfig: () => {},
}));
vi.mock("@/lib/tenant-context", () => ({
  resolveUserTenantId: mockResolveUserTenantId,
}));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  checkAccessRestrictionWithAudit: mockCheckAccessWithAudit,
}));
vi.mock("@/lib/audit/audit", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  logAuditAsync: mockLogAuditAsync,
}));

import { classifyRoute } from "@/lib/proxy/route-policy";
import { isBearerBypassRoute } from "@/lib/proxy/cors-gate";
import { handleApiAuth } from "@/lib/proxy/api-route";
import {
  _resetSessionPasskeyAuditForTests,
  API_DEFAULT_SESSION_READERS,
  isSessionGateOwnGate,
  isSessionGateTierA,
  isSessionGateTierB,
  SESSION_GATE_OWN_GATE,
  SESSION_GATE_TIER_A,
  SESSION_GATE_TIER_B,
  type SessionGateEntry,
} from "@/lib/proxy/session-passkey-gate";
import {
  dispatchFetch,
  fetchCallsTo,
  PASSKEY_BLOCKED,
  sessionResponseBody,
  sessionRoute,
} from "@/__tests__/helpers/proxy-session-fixtures";
import {
  parseRouteSource,
  hasRealCall,
  hasCallWithObjectFlag,
  limiterFlagFlowsToChecker,
  matchesInCodeText,
} from "./ast-guards";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const API_DIR = path.join(REPO_ROOT, "src/app/api");
const FIXED_UUID = "00000000-0000-4000-8000-000000000000";
const ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const GATE_VALUES = ["gated", "tier-a", "tier-b", "own-gate", "early-return"] as const;
type GateValue = (typeof GATE_VALUES)[number];

type GateDeclaration = { value: GateValue; reason?: string };

type ConcretePath = { path: string; method: string; outcome: GateValue };

type ManifestEntry = {
  kind: string;
  methods: string[];
  bearerBypass?: string[];
  auth?: string[];
  handlerAuthReason?: string;
  destructive?: boolean;
  sideEffectingGet?: string;
  operatorGated?: boolean;
  sessionPasskeyGate?: Record<string, GateDeclaration>;
  concretePaths?: ConcretePath[];
};

type Manifest = {
  routes: Record<string, ManifestEntry>;
};

const manifest = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "scripts/checks/route-policy-manifest.json"), "utf8"),
) as Manifest;

const patterns = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "scripts/checks/route-class-patterns.json"), "utf8"),
) as Record<string, unknown>;

function nonEmptyPattern(key: string): string {
  const value = patterns[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`route-class-patterns.json: "${key}" must be a non-empty string`);
  }
  return value;
}

const DELETE_SIGNAL = new RegExp(nonEmptyPattern("deleteSignal"));
const WRITE_PRIMITIVE = new RegExp(nonEmptyPattern("writePrimitive"));

// Walk src/app/api recursively, collecting every route.ts file's repo-relative path.
function walkRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkRouteFiles(full));
    } else if (entry.isFile() && entry.name === "route.ts") {
      out.push(path.relative(REPO_ROOT, full));
    }
  }
  return out;
}

// Convert a route file's directory to a concrete request pathname,
// substituting `[param]` segments with a fixed UUID literal.
function toConcretePath(repoRelPath: string): string {
  const dir = path.dirname(repoRelPath); // e.g. src/app/api/passwords/[id]
  const withoutPrefix = dir.replace(/^src\/app/, ""); // /api/passwords/[id]
  return withoutPrefix
    .split("/")
    .map((segment) => (/^\[.+\]$/.test(segment) ? FIXED_UUID : segment))
    .join("/");
}

// Extraction regex for exported HTTP method handlers. `async` is optional:
// 2 of 212 route files use the non-async `export function GET()` form
// (src/app/api/health/live/route.ts, src/app/api/mobile/.well-known/
// apple-app-site-association/route.ts). Re-verified against the full route
// universe at implementation time — no `export { x as GET }` re-export style
// exists in this codebase.
const METHOD_EXPORT_RE = /^export (async )?(function|const) (GET|POST|PUT|PATCH|DELETE)\b/gm;

function extractExportedMethods(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(METHOD_EXPORT_RE)) {
    found.add(match[3]);
  }
  return ALL_METHODS.filter((m) => found.has(m));
}

const routeFiles = walkRouteFiles(API_DIR).sort();
const manifestKeys = Object.keys(manifest.routes).sort();

// Inline exemption list for assertion 7 (sideEffectingGet floor), per plan:
// "an inline exemption list (path + >=10-char reason) in the test handles
// any future false positive of either pattern." Empty at implementation time
// — the receiver-shape writePrimitive pattern already excludes the one known
// false positive (watchtower/hibp's in-memory Map.delete).
const SIDE_EFFECTING_GET_EXEMPTIONS: Record<string, string> = {};

describe("route-policy-manifest.json parity", () => {
  it("assertion 1: bijection between route.ts files and manifest keys", () => {
    const missingFromManifest = routeFiles.filter((f) => !manifestKeys.includes(f));
    const staleInManifest = manifestKeys.filter((k) => !routeFiles.includes(k));

    expect(missingFromManifest, `route files with no manifest entry: ${missingFromManifest.join(", ")}`).toEqual([]);
    expect(staleInManifest, `manifest entries with no route file: ${staleInManifest.join(", ")}`).toEqual([]);
  });

  it("assertion 2: kind matches classifyRoute(concretePath) for every entry", () => {
    const mismatches: string[] = [];
    for (const repoRelPath of manifestKeys) {
      const concretePath = toConcretePath(repoRelPath);
      const actualKind = classifyRoute(concretePath).kind;
      const declaredKind = manifest.routes[repoRelPath].kind;
      if (actualKind !== declaredKind) {
        mismatches.push(`${repoRelPath}: declared=${declaredKind} actual=${actualKind}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("assertion 3: methods matches the exported HTTP handler set for every entry", () => {
    const mismatches: string[] = [];
    for (const repoRelPath of manifestKeys) {
      const source = readFileSync(path.join(REPO_ROOT, repoRelPath), "utf8");
      const actualMethods = extractExportedMethods(source);
      // Both sides are normalized to ALL_METHODS canonical order so a
      // declaration order difference (e.g. "DELETE,GET,PUT") does not
      // false-positive against the extraction order (e.g. "GET,PUT,DELETE").
      const declaredMethods = ALL_METHODS.filter((m) =>
        manifest.routes[repoRelPath].methods.includes(m),
      );
      if (JSON.stringify(actualMethods) !== JSON.stringify(declaredMethods)) {
        mismatches.push(
          `${repoRelPath}: declared=[${declaredMethods.join(",")}] actual=[${actualMethods.join(",")}]`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("assertion 4: bearerBypass matches isBearerBypassRoute per method, both directions", () => {
    const mismatches: string[] = [];
    for (const repoRelPath of manifestKeys) {
      const entry = manifest.routes[repoRelPath];
      const concretePath = toConcretePath(repoRelPath);
      const declaredBypass = new Set(entry.bearerBypass ?? []);
      for (const method of entry.methods) {
        const actualBypass = isBearerBypassRoute(concretePath, method);
        const declared = declaredBypass.has(method);
        if (actualBypass !== declared) {
          mismatches.push(
            `${repoRelPath} [${method}]: declared bearerBypass=${declared} actual isBearerBypassRoute=${actualBypass}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("assertion 5: public/self-enforced surface has handlerAuthReason (>=10 chars) and non-empty auth", () => {
    const kindsRequiringReason = new Set(["api-default", "public-share", "public-receiver"]);
    const violations: string[] = [];
    for (const repoRelPath of manifestKeys) {
      const entry = manifest.routes[repoRelPath];
      if (!kindsRequiringReason.has(entry.kind)) continue;

      if (!entry.handlerAuthReason || entry.handlerAuthReason.length < 10) {
        violations.push(`${repoRelPath}: handlerAuthReason missing or <10 chars`);
      }
      if (!entry.auth || entry.auth.length === 0) {
        violations.push(`${repoRelPath}: auth missing or empty`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("assertion 6: destructive <=> DELETE_SIGNAL member-set (re-derived)", () => {
    const mismatches: string[] = [];
    for (const repoRelPath of manifestKeys) {
      const source = readFileSync(path.join(REPO_ROOT, repoRelPath), "utf8");
      const actualDestructive = matchesInCodeText(parseRouteSource(source, repoRelPath), DELETE_SIGNAL);
      const declaredDestructive = manifest.routes[repoRelPath].destructive === true;
      if (actualDestructive !== declaredDestructive) {
        mismatches.push(
          `${repoRelPath}: declared destructive=${declaredDestructive} actual=${actualDestructive}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("assertion 7: sideEffectingGet floor — every GET-only route with a write primitive carries a reason (and vice versa)", () => {
    const violations: string[] = [];
    for (const repoRelPath of manifestKeys) {
      const entry = manifest.routes[repoRelPath];
      const isGetOnly = entry.methods.length === 1 && entry.methods[0] === "GET";
      const source = readFileSync(path.join(REPO_ROOT, repoRelPath), "utf8");
      const hasWritePrimitive =
        isGetOnly && matchesInCodeText(parseRouteSource(source, repoRelPath), WRITE_PRIMITIVE);
      const hasReason = Boolean(entry.sideEffectingGet && entry.sideEffectingGet.length >= 10);
      const exemptionReason = SIDE_EFFECTING_GET_EXEMPTIONS[repoRelPath];

      // Floor direction: a GET-only file with a direct write primitive MUST
      // declare a reason, unless explicitly exempted with its own reason.
      if (hasWritePrimitive && !hasReason) {
        if (!exemptionReason || exemptionReason.length < 10) {
          violations.push(`${repoRelPath}: GET-only route matches writePrimitive but has no sideEffectingGet reason`);
        }
      }

      // Stale direction: an entry carrying the field must actually match the
      // grep (or be GET-only at all) — otherwise the declaration is stale.
      if (hasReason && !hasWritePrimitive) {
        violations.push(`${repoRelPath}: declares sideEffectingGet but is not a GET-only route matching writePrimitive`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("assertion 8a: every maintenance/admin route explicitly declares operatorGated (true or false+reason)", () => {
    const pathFloorDirs = [
      path.join(API_DIR, "maintenance"),
      path.join(API_DIR, "admin"),
    ];
    const pathFloorFiles = pathFloorDirs.flatMap(walkRouteFiles).map((f) => path.relative(REPO_ROOT, f));

    const violations: string[] = [];
    for (const repoRelPath of pathFloorFiles) {
      const entry = manifest.routes[repoRelPath];
      if (!entry || entry.operatorGated === undefined) {
        violations.push(`${repoRelPath}: missing explicit operatorGated declaration`);
        continue;
      }
      if (entry.operatorGated === false) {
        if (!entry.handlerAuthReason || entry.handlerAuthReason.length < 10) {
          violations.push(`${repoRelPath}: operatorGated=false requires handlerAuthReason >=10 chars`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("assertion 8b: every operatorGated:true entry enforces admin auth AND fail-closed rate limiting", () => {
    // Two invariants for every operator-gated route, verified by AST (not lexical
    // source.includes) so a required call hidden in a comment / string / unused
    // import cannot satisfy the guard:
    //   1. Admin auth: verifyAdminToken( + requireMaintenanceOperator( as real calls
    //   2. Fail-closed rate limiting (#629): a real createRateLimiter({
    //      failClosedOnRedisError: true }) call, a real checkRateLimitOrFail( call,
    //      AND the fail-closed limiter flows into checkRateLimitOrFail's `limiter:`
    //      arg (limiterFlagFlowsToChecker — closes the "flag exists somewhere vs.
    //      the consumed limiter carries it" dataflow gap).
    // It does NOT verify the key is tenant-scoped — that argument-level contract is
    // pinned per route in the maintenance route.test.ts files ("returns 429 when
    // rate limited"), a separate layer this existence check cannot see.
    const violations: string[] = [];
    for (const repoRelPath of manifestKeys) {
      if (manifest.routes[repoRelPath].operatorGated !== true) continue;
      const source = readFileSync(path.join(REPO_ROOT, repoRelPath), "utf8");
      const sf = parseRouteSource(source, repoRelPath);
      if (!hasRealCall(sf, "verifyAdminToken")) {
        violations.push(`${repoRelPath}: operatorGated=true but missing verifyAdminToken(`);
      }
      if (!hasRealCall(sf, "requireMaintenanceOperator")) {
        violations.push(`${repoRelPath}: operatorGated=true but missing requireMaintenanceOperator(`);
      }
      if (!hasCallWithObjectFlag(sf, "createRateLimiter", "failClosedOnRedisError", true)) {
        violations.push(
          `${repoRelPath}: operatorGated=true but missing createRateLimiter({ failClosedOnRedisError: true })`,
        );
      }
      if (!hasRealCall(sf, "checkRateLimitOrFail")) {
        violations.push(`${repoRelPath}: operatorGated=true but missing checkRateLimitOrFail(`);
      }
      if (!limiterFlagFlowsToChecker(sf)) {
        violations.push(
          `${repoRelPath}: operatorGated=true but the fail-closed limiter does not flow into checkRateLimitOrFail`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it("assertion 8c: reverse drift — every route calling requireMaintenanceOperator( is declared operatorGated:true", () => {
    const violations: string[] = [];
    for (const repoRelPath of routeFiles) {
      const source = readFileSync(path.join(REPO_ROOT, repoRelPath), "utf8");
      if (!hasRealCall(parseRouteSource(source, repoRelPath), "requireMaintenanceOperator")) continue;
      const entry = manifest.routes[repoRelPath];
      if (!entry || entry.operatorGated !== true) {
        violations.push(`${repoRelPath}: calls requireMaintenanceOperator( but is not declared operatorGated:true`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// ─── Session passkey gate (plan session-api-passkey-gate, C1 / I1 / I2) ──────

const MIN_GATE_REASON = 10;
const APP_ORIGIN = "http://localhost:3000";
const SESSION_PATH = "/api/auth/session";
// What the client sends for an Auth.js entry's `<id>` provider segment.
const PROVIDER_ID = "google";

/** True for a route directory with a catch-all (`[...x]` / `[[...x]]`) segment. */
function isCatchAll(repoRelPath: string): boolean {
  return path.dirname(repoRelPath).split("/").some((segment) => /^\[\[?\.\.\./.test(segment));
}

/** The request pathname prefix a catch-all route serves (up to its catch-all segment). */
function catchAllPrefix(repoRelPath: string): string {
  const segments = path.dirname(repoRelPath).replace(/^src\/app/, "").split("/");
  const at = segments.findIndex((segment) => /^\[\[?\.\.\./.test(segment));
  return `${segments.slice(0, at).join("/")}/`;
}

type GateCell = { route: string; method: string; path: string; outcome: GateValue };

/**
 * Every (method, pathname) the outcome table evaluates. A catch-all route
 * contributes only its concretePaths: its derived UUID path is one spelling
 * of many and says nothing about the others.
 */
function gateCells(): GateCell[] {
  const cells: GateCell[] = [];
  for (const route of manifestKeys) {
    const entry = manifest.routes[route];
    if (isCatchAll(route)) {
      for (const cp of entry.concretePaths ?? []) {
        cells.push({ route, method: cp.method, path: cp.path, outcome: cp.outcome });
      }
      continue;
    }
    for (const method of entry.methods) {
      const declared = entry.sessionPasskeyGate?.[method];
      if (!declared) continue; // assertion 9 reports the missing declaration
      cells.push({ route, method, path: toConcretePath(route), outcome: declared.value });
    }
  }
  return cells;
}

const entryKey = (e: { method: string; path: string }) => `${e.method} ${e.path}`;

describe("route-policy-manifest.json — sessionPasskeyGate parity", () => {
  it("assertion 9: every route declares sessionPasskeyGate for exactly its methods, with a valid value and a reason off `gated`", () => {
    const violations: string[] = [];
    for (const repoRelPath of manifestKeys) {
      const entry = manifest.routes[repoRelPath];
      const gate = entry.sessionPasskeyGate;
      if (!gate) {
        violations.push(`${repoRelPath}: sessionPasskeyGate missing`);
        continue;
      }
      const declared = Object.keys(gate);
      for (const method of entry.methods) {
        if (!declared.includes(method)) violations.push(`${repoRelPath} [${method}]: no sessionPasskeyGate declaration`);
      }
      for (const method of declared) {
        if (!entry.methods.includes(method)) violations.push(`${repoRelPath} [${method}]: declared but not in methods`);
        const { value, reason } = gate[method];
        if (!(GATE_VALUES as readonly string[]).includes(value)) {
          violations.push(`${repoRelPath} [${method}]: value "${value}" is not one of ${GATE_VALUES.join(" | ")}`);
        }
        if (value !== "gated" && (!reason || reason.length < MIN_GATE_REASON)) {
          violations.push(`${repoRelPath} [${method}]: ${value} needs a reason (>=${MIN_GATE_REASON} chars)`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("assertion 9b: a catch-all route declares concretePaths covering every method under its prefix; no other route does", () => {
    const violations: string[] = [];
    let catchAlls = 0;
    for (const repoRelPath of manifestKeys) {
      const entry = manifest.routes[repoRelPath];
      if (!isCatchAll(repoRelPath)) {
        if (entry.concretePaths !== undefined) violations.push(`${repoRelPath}: concretePaths on a non-catch-all route`);
        continue;
      }
      catchAlls += 1;
      const concretePaths = entry.concretePaths ?? [];
      if (concretePaths.length === 0) {
        violations.push(`${repoRelPath}: catch-all route without concretePaths`);
        continue;
      }
      const prefix = catchAllPrefix(repoRelPath);
      for (const cp of concretePaths) {
        if (!entry.methods.includes(cp.method)) violations.push(`${repoRelPath}: concretePath ${entryKey(cp)} uses an undeclared method`);
        if (!cp.path.startsWith(prefix)) violations.push(`${repoRelPath}: concretePath ${cp.path} is outside ${prefix}`);
        if (!(GATE_VALUES as readonly string[]).includes(cp.outcome)) {
          violations.push(`${repoRelPath}: concretePath ${entryKey(cp)} outcome "${cp.outcome}" is not a gate value`);
        }
      }
      for (const method of entry.methods) {
        if (!concretePaths.some((cp) => cp.method === method)) {
          violations.push(`${repoRelPath} [${method}]: no concretePath for this method`);
        }
      }
    }
    expect(violations).toEqual([]);
    // [...nextauth] exists today; a zero here means the detector broke.
    expect(catchAlls).toBeGreaterThan(0);
  });

  it("assertion 9c: declared tier-a / tier-b / own-gate values agree with the runtime lists, both ways", () => {
    const predicates: [GateValue, (method: string, pathname: string) => boolean][] = [
      ["tier-a", isSessionGateTierA],
      ["tier-b", isSessionGateTierB],
      ["own-gate", isSessionGateOwnGate],
    ];
    const violations: string[] = [];
    for (const cell of gateCells()) {
      for (const [value, predicate] of predicates) {
        const declared = cell.outcome === value;
        const listed = predicate(cell.method, cell.path);
        if (declared !== listed) {
          violations.push(`${cell.route} ${entryKey(cell)}: declared ${value}=${declared}, runtime list=${listed}`);
        }
      }
    }

    // Every runtime entry is declared somewhere (an unreachable entry is a
    // stale exemption).
    const cells = gateCells();
    const lists: [GateValue, readonly SessionGateEntry[]][] = [
      ["tier-a", SESSION_GATE_TIER_A],
      ["tier-b", SESSION_GATE_TIER_B],
      ["own-gate", SESSION_GATE_OWN_GATE],
    ];
    for (const [value, entries] of lists) {
      for (const e of entries) {
        const pathname = e.path.replace("<id>", PROVIDER_ID);
        const hit = cells.some((c) => c.method === e.method && c.path === pathname && c.outcome === value);
        if (!hit) violations.push(`${value} entry ${entryKey(e)} has no manifest declaration`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("assertion 9d: every API_DEFAULT_SESSION_READERS entry is a gated api-default route method", () => {
    const violations: string[] = [];
    for (const e of API_DEFAULT_SESSION_READERS) {
      const route = manifestKeys.find((k) => !isCatchAll(k) && toConcretePath(k) === e.path);
      const entry = route ? manifest.routes[route] : undefined;
      if (!entry) {
        violations.push(`${entryKey(e)}: no route file`);
        continue;
      }
      if (entry.kind !== "api-default") violations.push(`${entryKey(e)}: kind is ${entry.kind}`);
      if (entry.sessionPasskeyGate?.[e.method]?.value !== "gated") violations.push(`${entryKey(e)}: not declared gated`);
    }
    expect(violations).toEqual([]);
  });
});

// I2: the exemption sets, as literals. Changing a runtime list fails here
// until this snapshot is changed with it.
const I2_TIER_A = [
  "GET /api/auth/session",
  "POST /api/auth/session",
  "GET /api/auth/csrf",
  "GET /api/auth/providers",
  "GET /api/auth/error",
  "GET /api/auth/verify-request",
  "GET /api/auth/signin",
  "POST /api/auth/signin",
  "POST /api/auth/signin/<id>",
  "GET /api/auth/callback/<id>",
  "POST /api/auth/callback/<id>",
  "GET /api/auth/signout",
  "POST /api/auth/signout",
  "POST /api/auth/passkey/options",
  "POST /api/auth/passkey/options/email",
  "POST /api/auth/passkey/verify",
];
const I2_TIER_B = [
  "GET /api/webauthn/credentials",
  "POST /api/webauthn/register/options",
  "POST /api/webauthn/register/verify",
  "GET /api/user/auth-provider",
  "DELETE /api/vault/delegation",
];
const I2_OWN_GATE = [
  "GET /api/mobile/authorize",
  "GET /api/mcp/authorize",
  "POST /api/mcp/authorize/consent",
];
// Routes that mint or bind a credential or key. An exemption on one would let
// a blocked session mint a durable credential.
const KEY_MINTING_PREFIXES = [
  "/api/api-keys",
  "/api/extension/token",
  "/api/extension/bridge-code",
  "/api/extension/key",
  "/api/mobile/token",
  "/api/mobile/autofill-token",
  "/api/mcp/token",
  "/api/mcp/register",
];
// The one vault-route exemption: locking the vault must still revoke delegation.
const I2_DENYLIST_EXCEPTION = "DELETE /api/vault/delegation";

const underPrefix = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Why `entry` may not be exempt, or null. */
function i2DenyReason(entry: SessionGateEntry): string | null {
  if (entryKey(entry) === I2_DENYLIST_EXCEPTION) return null;
  if (underPrefix(entry.path, "/api/vault")) return "vault route";
  if (underPrefix(entry.path, "/api/tenant")) return "tenant route";
  if (KEY_MINTING_PREFIXES.some((prefix) => underPrefix(entry.path, prefix))) return "key-minting route";
  if (entry.method === "DELETE" && underPrefix(entry.path, "/api/webauthn")) return "webauthn delete";
  return null;
}

describe("session passkey gate — I2 exemption sets", () => {
  it("Tier A equals the literal snapshot", () => {
    expect(SESSION_GATE_TIER_A.map(entryKey)).toEqual(I2_TIER_A);
  });

  it("Tier B equals the literal snapshot", () => {
    expect(SESSION_GATE_TIER_B.map(entryKey)).toEqual(I2_TIER_B);
  });

  it("the own-gate set equals the literal snapshot", () => {
    expect(SESSION_GATE_OWN_GATE.map(entryKey)).toEqual(I2_OWN_GATE);
  });

  it("no exemption is on a vault, tenant, key-minting or webauthn-delete route (except DELETE /api/vault/delegation)", () => {
    const violations = [...SESSION_GATE_TIER_A, ...SESSION_GATE_TIER_B, ...SESSION_GATE_OWN_GATE]
      .map((entry) => [entryKey(entry), i2DenyReason(entry)] as const)
      .filter(([, reason]) => reason !== null)
      .map(([key, reason]) => `${key}: ${reason}`);
    expect(violations).toEqual([]);
  });

  it("the denylist itself refuses the routes it names (positive control)", () => {
    const probe = (method: string, p: string) => i2DenyReason({ method, path: p, reason: "probe" });
    expect(probe("GET", "/api/vault/status")).toBe("vault route");
    expect(probe("POST", "/api/vault/delegation")).toBe("vault route");
    expect(probe("PUT", "/api/tenant/policy")).toBe("tenant route");
    expect(probe("POST", "/api/mcp/token")).toBe("key-minting route");
    expect(probe("DELETE", "/api/webauthn/credentials/x")).toBe("webauthn delete");
    expect(probe("DELETE", "/api/vault/delegation")).toBeNull();
  });
});

describe("session passkey gate — manifest outcome table (real handleApiAuth + getSessionInfo)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let tokenSeq = 0;

  function nextToken(): string {
    tokenSeq += 1;
    return `5e55bbbb-0000-4000-8000-${tokenSeq.toString(16).padStart(12, "0")}`;
  }

  function request(method: string, pathname: string, headers: Record<string, string>): NextRequest {
    return new NextRequest(`${APP_ORIGIN}${pathname}`, {
      method,
      headers: { origin: APP_ORIGIN, ...headers },
    });
  }

  const cookieHeaders = () => ({ cookie: `authjs.session-token=${nextToken()}` });

  beforeEach(() => {
    vi.stubEnv("AUTH_URL", "");
    vi.stubEnv("NEXTAUTH_URL", "");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("APP_URL", APP_ORIGIN);
    _resetSessionPasskeyAuditForTests();
    mockLogAuditAsync.mockReset().mockResolvedValue(undefined);
    mockCheckAccessWithAudit.mockReset().mockResolvedValue({ allowed: true });
    mockResolveUserTenantId.mockReset().mockResolvedValue("t-1");
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(dispatchFetch(sessionRoute(sessionResponseBody("u-1", PASSKEY_BLOCKED))));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  /** The (response, session fetch) pair each declared value stands for. */
  async function expectOutcome(res: Response, outcome: GateValue) {
    const sessionFetches = fetchCallsTo(fetchSpy, SESSION_PATH).length;
    if (outcome === "gated") {
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("PASSKEY_REQUIRED");
      expect(sessionFetches).toBe(1);
      return;
    }
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    const reads = outcome === "tier-b" || outcome === "own-gate" ? 1 : 0;
    expect(sessionFetches).toBe(reads);
  }

  const cells = gateCells().map((c) => [c.outcome, c.method, c.path, c] as const);

  it("evaluates a non-empty table", () => {
    expect(cells.length).toBeGreaterThan(manifestKeys.length);
  });

  it.each(cells)("cookie: %s — %s %s", async (outcome, method, pathname) => {
    await expectOutcome(await handleApiAuth(request(method, pathname, cookieHeaders())), outcome);
  });

  it.each(cells)("cookie + junk Bearer: %s — %s %s", async (outcome, method, pathname) => {
    const headers = { ...cookieHeaders(), authorization: "Bearer junk" };
    await expectOutcome(await handleApiAuth(request(method, pathname, headers)), outcome);
  });

  const bearerCells = manifestKeys.flatMap((route) =>
    (manifest.routes[route].bearerBypass ?? []).map((method) => [method, toConcretePath(route)] as const),
  );

  it("has Bearer-bypass cells", () => {
    expect(bearerCells.length).toBeGreaterThan(0);
  });

  it.each(bearerCells)("Bearer only: %s %s passes through without a session read", async (method, pathname) => {
    const res = await handleApiAuth(request(method, pathname, { authorization: "Bearer junk" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
