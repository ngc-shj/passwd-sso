/**
 * Exemption lists and audit write for the proxy's session passkey gate
 * (api-route.ts). A blocked session's cookie-bearing `/api/*` request is
 * refused with PASSKEY_REQUIRED unless it matches one of the lists below.
 * The page proxy (page-route.ts) writes its blocked-navigation row through the
 * same audit write.
 *
 * Every list is literal and method-aware: an entry exempts one method on one
 * path, never a prefix, so a new route is gated until it is listed here.
 */

import type { NextRequest } from "next/server";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { PASSKEY_AUDIT_DEDUP_MS } from "@/lib/auth/policy/passkey-enforcement";

export interface SessionGateEntry {
  readonly method: string;
  readonly path: string;
  readonly reason: string;
}

// Auth.js routes under this base. `<id>` in an entry's path stands for the
// provider ID: exactly one segment.
const AUTHJS_BASE = "/api/auth/";
const PROVIDER_ID_SEGMENT = "<id>";

/**
 * Auth.js's own handler paths. Matched the way Auth.js parses an action
 * (`parseActionAndProviderId`): the rest of the path split on "/", empty
 * segments dropped, one segment for the action and at most one for the
 * provider. So the proxy exempts exactly the request Auth.js dispatches as
 * that action.
 */
const AUTHJS_TIER_A: readonly SessionGateEntry[] = [
  { method: "GET", path: "/api/auth/session", reason: "getSessionInfo's own session read; useSession()" },
  { method: "POST", path: "/api/auth/session", reason: "useSession().update()" },
  { method: "GET", path: "/api/auth/csrf", reason: "Auth.js CSRF token for sign-in and sign-out" },
  { method: "GET", path: "/api/auth/providers", reason: "Auth.js provider list for the sign-in page" },
  { method: "GET", path: "/api/auth/error", reason: "Auth.js error page" },
  { method: "GET", path: "/api/auth/verify-request", reason: "Auth.js magic-link sent page" },
  { method: "GET", path: "/api/auth/signin", reason: "Auth.js sign-in page" },
  { method: "POST", path: "/api/auth/signin", reason: "Auth.js sign-in" },
  { method: "POST", path: "/api/auth/signin/<id>", reason: "Auth.js provider sign-in (a fresh sign-in satisfies the step-up)" },
  { method: "GET", path: "/api/auth/callback/<id>", reason: "Auth.js provider callback" },
  { method: "POST", path: "/api/auth/callback/<id>", reason: "Auth.js provider callback (form_post, magic link)" },
  { method: "GET", path: "/api/auth/signout", reason: "Auth.js sign-out page" },
  { method: "POST", path: "/api/auth/signout", reason: "Auth.js sign-out; a blocked member can always sign out" },
];

const EXACT_TIER_A: readonly SessionGateEntry[] = [
  { method: "POST", path: "/api/auth/passkey/options", reason: "pre-auth passkey sign-in challenge" },
  { method: "POST", path: "/api/auth/passkey/options/email", reason: "pre-auth passkey sign-in challenge (email)" },
  { method: "POST", path: "/api/auth/passkey/verify", reason: "pre-auth passkey sign-in verification" },
];

/**
 * Tier A — pre-session bypass. Skips the whole session gate, before any
 * session read: these are the requests the proxy itself makes and Auth.js's
 * own paths. Passkey reauth (`/api/auth/passkey/reauth/*`) is not here.
 */
export const SESSION_GATE_TIER_A: readonly SessionGateEntry[] = [
  ...AUTHJS_TIER_A,
  ...EXACT_TIER_A,
];

/**
 * Tier B — passkey-only exemption. Consulted after the 401 and IP checks,
 * which still apply. These are what the passkey registration screen and the
 * root providers call while the session is blocked.
 */
export const SESSION_GATE_TIER_B: readonly SessionGateEntry[] = [
  { method: "GET", path: "/api/webauthn/credentials", reason: "registration screen lists the credentials" },
  { method: "POST", path: "/api/webauthn/register/options", reason: "registration challenge; always recency-bound" },
  { method: "POST", path: "/api/webauthn/register/verify", reason: "registration; always recency-bound" },
  { method: "GET", path: "/api/user/auth-provider", reason: "registration screen picks the step-up method" },
  { method: "DELETE", path: "/api/vault/delegation", reason: "VaultProvider's lock and pagehide revoke delegation" },
];

/**
 * Routes that answer a blocked session in their own response shape. The
 * proxy reads the session and passes the request through; each route refuses
 * through its own `passkeyEnforcementBlocks` call.
 */
export const SESSION_GATE_OWN_GATE: readonly SessionGateEntry[] = [
  { method: "GET", path: "/api/mobile/authorize", reason: "iOS redirect shape; reached with no cookie on first arrival" },
  { method: "GET", path: "/api/mcp/authorize", reason: "OAuth error-redirect shape" },
  { method: "POST", path: "/api/mcp/authorize/consent", reason: "OAuth error-redirect shape" },
];

/**
 * API_DEFAULT routes whose handler reads the session. On these an invalid
 * session answers 401 at the proxy, whatever made it invalid, so the route's
 * `auth()` never sees a session this gate did not evaluate.
 */
export const API_DEFAULT_SESSION_READERS: readonly SessionGateEntry[] = [
  { method: "POST", path: "/api/auth/passkey/reauth/options", reason: "step-up reauth reads the session" },
  { method: "POST", path: "/api/auth/passkey/reauth/verify", reason: "step-up reauth reads the session" },
];

function authjsSegments(pathname: string): string[] | null {
  if (!pathname.startsWith(AUTHJS_BASE)) return null;
  const segments = pathname.slice(AUTHJS_BASE.length).split("/").filter(Boolean);
  return segments.length === 1 || segments.length === 2 ? segments : null;
}

function matchesAuthjsEntry(entry: SessionGateEntry, segments: readonly string[]): boolean {
  const [action, providerId] = entry.path.slice(AUTHJS_BASE.length).split("/");
  if (segments[0] !== action) return false;
  return providerId === PROVIDER_ID_SEGMENT ? segments.length === 2 : segments.length === 1;
}

function matchesExact(entries: readonly SessionGateEntry[], method: string, pathname: string): boolean {
  return entries.some((entry) => entry.method === method && entry.path === pathname);
}

export function isSessionGateTierA(method: string, pathname: string): boolean {
  if (matchesExact(EXACT_TIER_A, method, pathname)) return true;
  const segments = authjsSegments(pathname);
  if (!segments) return false;
  return AUTHJS_TIER_A.some(
    (entry) => entry.method === method && matchesAuthjsEntry(entry, segments),
  );
}

export function isSessionGateTierB(method: string, pathname: string): boolean {
  return matchesExact(SESSION_GATE_TIER_B, method, pathname);
}

export function isSessionGateOwnGate(method: string, pathname: string): boolean {
  return matchesExact(SESSION_GATE_OWN_GATE, method, pathname);
}

export function isApiDefaultSessionReader(method: string, pathname: string): boolean {
  return matchesExact(API_DEFAULT_SESSION_READERS, method, pathname);
}

// ─── Audit metadata ───────────────────────────────────────────────────────────

/**
 * The top-level directories under `src/app/api/`. A literal, not a directory
 * read: the proxy bundle cannot use node:fs. A test pins it to the tree.
 */
export const API_ROUTE_KEYS = [
  "admin",
  "api-keys",
  "audit-logs",
  "auth",
  "csp-report",
  "directory-sync",
  "emergency-access",
  "extension",
  "folders",
  "health",
  "maintenance",
  "mcp",
  "mobile",
  "notifications",
  "passwords",
  "scim",
  "sends",
  "sessions",
  "share-links",
  "tags",
  "teams",
  "tenant",
  "travel-mode",
  "user",
  "v1",
  "vault",
  "watchtower",
  "webauthn",
] as const;

export const OTHER_ROUTE_KEY = "other";

export const AUDIT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export const OTHER_METHOD = "OTHER";

const ROUTE_KEY_SET: ReadonlySet<string> = new Set(API_ROUTE_KEYS);
const AUDIT_METHOD_SET: ReadonlySet<string> = new Set(AUDIT_METHODS);

/**
 * `"<METHOD> /api/<routeKey>"`, both parts from closed sets, so the audit
 * metadata and the limiter key never carry an ID or caller-chosen text.
 */
export function blockedPath(method: string, pathname: string): string {
  const auditMethod = AUDIT_METHOD_SET.has(method) ? method : OTHER_METHOD;
  const firstSegment = pathname.startsWith("/api/") ? pathname.slice("/api/".length).split("/")[0] : "";
  const routeKey = ROUTE_KEY_SET.has(firstSegment) ? firstSegment : OTHER_ROUTE_KEY;
  return `${auditMethod} /api/${routeKey}`;
}

// ─── Audit write ──────────────────────────────────────────────────────────────

const AUDIT_LIMITER_OPTIONS = { windowMs: PASSKEY_AUDIT_DEDUP_MS, max: 1 } as const;

// Bounds the durable audit write on the refusal arm, not the refusal: every
// blocked request is denied, but each user writes at most one row per
// blockedPath per window. Redis-shared across processes. Deliberately NOT
// failClosedOnRedisError: a Redis outage falls back to memory and keeps
// writing rows instead of none.
let auditLimiter = createRateLimiter(AUDIT_LIMITER_OPTIONS);

/**
 * @internal Test-only — drops the limiter's in-memory fallback counters, and
 * only those: keys already held in Redis survive. A test that needs a clean
 * window per run must also run without Redis (mock `@/lib/redis`'s
 * `getRedis` to return null).
 */
export function _resetSessionPasskeyAuditForTests(): void {
  auditLimiter = createRateLimiter(AUDIT_LIMITER_OPTIONS);
}

export async function auditSessionPasskeyBlock(args: {
  req: NextRequest;
  userId: string;
  tenantId: string;
  blockedPath: string;
}): Promise<void> {
  const { req, userId, tenantId } = args;
  const limited = await auditLimiter.check(
    `rl:passkey_session_gate_audit:${userId}:${args.blockedPath}`,
  );
  if (!limited.allowed) return;
  await logAuditAsync({
    ...tenantAuditBase(req, userId, tenantId),
    action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
    metadata: { blockedPath: args.blockedPath },
  });
}
