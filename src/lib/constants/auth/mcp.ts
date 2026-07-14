import {
  MS_PER_MINUTE,
  MS_PER_HOUR,
  SEC_PER_MINUTE,
  SEC_PER_HOUR,
  SEC_PER_DAY,
} from "../time";

export const MCP_TOKEN_PREFIX = "mcp_";
export const MCP_CLIENT_ID_PREFIX = "mcpc_";

// McpClient.clientId is @db.VarChar(64). Cap an attacker-supplied client_id to
// this length before writing it into audit metadata (see /api/mcp/token).
export const MCP_CLIENT_ID_MAX_LENGTH = 64;

// Presented OAuth credentials are opaque at the HTTP boundary. Authorization
// codes and confidential-client secrets issued today are 43 chars; access and
// refresh tokens are 47 / 48 chars. Keep bounded headroom for a future
// versioned format without accepting multi-kilobyte values into hashing and
// lookup paths.
export const MCP_AUTHORIZATION_CODE_MAX_LENGTH = 256;
export const MCP_PRESENTED_TOKEN_MAX_LENGTH = 256;
export const MCP_CLIENT_SECRET_MAX_LENGTH = 256;

// RFC 7009 permits registered/extension token type hints. Unsupported hints
// are ignored by the revocation endpoint, but still need a bounded wire shape.
export const MCP_TOKEN_TYPE_HINT_MAX_LENGTH = 256;

// MCP scope values (subset of SA scopes, read-only for safety)
export const MCP_SCOPE = {
  CREDENTIALS_LIST: "credentials:list",
  CREDENTIALS_USE: "credentials:use",
  TEAM_CREDENTIALS_READ: "team:credentials:read",
  VAULT_STATUS: "vault:status",
  VAULT_UNLOCK_DATA: "vault:unlock-data",
  PASSWORDS_READ: "passwords:read",
  PASSWORDS_WRITE: "passwords:write",
  DELEGATION_CHECK: "delegation:check",
  SSH_SIGN: "ssh:sign",
} as const;

export type McpScope = (typeof MCP_SCOPE)[keyof typeof MCP_SCOPE];
export const MCP_SCOPES = Object.values(MCP_SCOPE) as McpScope[];

// A delegation session authorizes the token's agent to DECRYPT the delegated
// entries, so it requires the `credentials:use` capability. `credentials:list`
// is metadata-only by contract and must NOT grant delegation. (The legacy
// `credentials:decrypt` alias was expanded to list+use at consent before its
// removal in 133ecf30; no stored token carries it.)
// SSoT for both the POST authorization gate and the UI availability flag.
export function canDelegate(scope: string): boolean {
  return scope
    .split(",")
    .map((s) => s.trim())
    .includes(MCP_SCOPE.CREDENTIALS_USE);
}

// Risk levels for consent UI badge coloring
export type ScopeRiskLevel = "read" | "use" | "write";

export const MCP_SCOPE_RISK: Record<McpScope, ScopeRiskLevel> = {
  [MCP_SCOPE.CREDENTIALS_LIST]: "read",
  [MCP_SCOPE.VAULT_STATUS]: "read",
  [MCP_SCOPE.CREDENTIALS_USE]: "use",
  [MCP_SCOPE.PASSWORDS_READ]: "use",
  [MCP_SCOPE.VAULT_UNLOCK_DATA]: "use",
  [MCP_SCOPE.TEAM_CREDENTIALS_READ]: "use",
  [MCP_SCOPE.PASSWORDS_WRITE]: "write",
  [MCP_SCOPE.DELEGATION_CHECK]: "use",
  [MCP_SCOPE.SSH_SIGN]: "use",
};

// OAuth 2.1 constants
export const MCP_CODE_EXPIRY_SEC = 5 * SEC_PER_MINUTE;
export const MCP_TOKEN_EXPIRY_SEC = SEC_PER_HOUR;
export const MCP_TOKEN_MAX_EXPIRY_SEC = SEC_PER_DAY;

// Limits
export const MAX_MCP_CLIENTS_PER_TENANT = 10;
export const MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS = 5 * MS_PER_MINUTE;

// MCP protocol
export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const MCP_SERVER_NAME = "passwd-sso";
export const MCP_SERVER_VERSION = "1.0.0";

// Loopback redirect URI regex shared by:
//   - DCR (`/api/mcp/register`)
//   - Manual MCP client management (`/api/tenant/mcp-clients`, `/api/tenant/mcp-clients/[id]`)
//   - Frontend validator (`mcp-client-card.tsx`)
// The CSP `form-action` directive in `proxy.ts` MUST mirror the host set
// accepted here (`localhost`, `127.0.0.1`, `[::1]`) — any host accepted by
// this regex but missing from the CSP causes the consent-form 302 redirect
// to be CSP-blocked.
//
// RFC 8252 §7.3 mandates loopback IP literal support and "MUST allow any
// port"; §8.3 marks `localhost` as NOT RECOMMENDED but real OAuth clients
// (Claude Code, Claude Desktop) use it, so we keep it for compatibility.
//
// Pre-filter: callers should run `z.string().url()` first so `new URL()`
// rejects invalid ports (>65535) before this regex sees them.
export const LOOPBACK_REDIRECT_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//;

// DCR (Dynamic Client Registration) constants
export const MCP_REFRESH_TOKEN_PREFIX = "mcpr_";
export const MCP_REFRESH_TOKEN_EXPIRY_SEC = 7 * SEC_PER_DAY;
// Absolute cap on a refresh-token family lifetime — mirrors ExtensionToken.familyCreatedAt
// (30 d) for parity with the extension. Beyond this cap, exchangeRefreshToken refuses
// regardless of individual token validity. Value chosen to match the extension cap.
export const MCP_REFRESH_TOKEN_FAMILY_ABSOLUTE_TIMEOUT_SEC = 30 * SEC_PER_DAY;
// 15-min unclaimed hold window — generous for the register→consent→claim human
// flow while draining 4× faster than the old 1-hour window (see plan).
export const MCP_DCR_UNCLAIMED_EXPIRY_SEC = 15 * SEC_PER_MINUTE;
// Table-bloat backstop, not a tight chokepoint — the real growth bound is the
// 15-min TTL + lazy-cleanup + 20/h-per-/64 rate limit; 1000 gives ~10× headroom
// over realistic legit volume so normal traffic never reaches this ceiling.
export const MAX_UNCLAIMED_DCR_CLIENTS = 1000;
export const DCR_RATE_LIMIT_WINDOW_MS = MS_PER_HOUR;
export const DCR_RATE_LIMIT_MAX = 20; // per IP (/64 for IPv6)

// Refresh-token exchange failure reasons (returned to caller in `reason`
// field of the typed result; surfaced to the client via the route handler).
// Defined as a const-object so callers don't drift into raw string literals
// (matches AUDIT_ACTION style).
export const REFRESH_EXCHANGE_REASON = {
  REPLAY: "replay",
  CONCURRENT_ROTATION_REVOKED: "concurrent_rotation_revoked",
  EXPIRED: "expired",
  REVOKED: "revoked",
  PASSKEY_REQUIRED: "passkey_required",
} as const;
export type RefreshExchangeReason =
  (typeof REFRESH_EXCHANGE_REASON)[keyof typeof REFRESH_EXCHANGE_REASON];

// Audit metadata `reason` value for MCP_REFRESH_TOKEN_FAMILY_REVOKED audit
// emission — identifies WHY the family was revoked.
export const FAMILY_REVOKED_REASON = {
  CONCURRENT_ROTATION: "concurrent_rotation",
  REPLAY: "replay",
} as const;
export type FamilyRevokedReason =
  (typeof FAMILY_REVOKED_REASON)[keyof typeof FAMILY_REVOKED_REASON];
