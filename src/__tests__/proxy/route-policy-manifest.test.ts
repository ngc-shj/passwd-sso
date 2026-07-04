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
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { classifyRoute } from "@/lib/proxy/route-policy";
import { isBearerBypassRoute } from "@/lib/proxy/cors-gate";
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

type ManifestEntry = {
  kind: string;
  methods: string[];
  bearerBypass?: string[];
  auth?: string[];
  handlerAuthReason?: string;
  destructive?: boolean;
  sideEffectingGet?: string;
  operatorGated?: boolean;
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
