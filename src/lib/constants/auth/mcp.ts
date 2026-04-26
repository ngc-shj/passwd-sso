import { MS_PER_MINUTE } from "../time";

export const MCP_TOKEN_PREFIX = "mcp_";
export const MCP_CLIENT_ID_PREFIX = "mcpc_";

// MCP scope values (subset of SA scopes, read-only for safety)
export const MCP_SCOPE = {
  CREDENTIALS_LIST: "credentials:list",
  CREDENTIALS_USE: "credentials:use",
  TEAM_CREDENTIALS_READ: "team:credentials:read",
  VAULT_STATUS: "vault:status",
  VAULT_UNLOCK_DATA: "vault:unlock-data",
  PASSWORDS_READ: "passwords:read",
  PASSWORDS_WRITE: "passwords:write",
} as const;

export type McpScope = (typeof MCP_SCOPE)[keyof typeof MCP_SCOPE];
export const MCP_SCOPES = Object.values(MCP_SCOPE) as McpScope[];

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
};

// OAuth 2.1 constants
export const MCP_CODE_EXPIRY_SEC = 300; // 5 minutes
export const MCP_TOKEN_EXPIRY_SEC = 3600; // 1 hour
export const MCP_TOKEN_MAX_EXPIRY_SEC = 86400; // 24 hours

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
export const MCP_REFRESH_TOKEN_EXPIRY_SEC = 604800; // 7 days
export const MCP_DCR_UNCLAIMED_EXPIRY_SEC = 86400; // 24 hours
export const MAX_UNCLAIMED_DCR_CLIENTS = 100;
export const DCR_RATE_LIMIT_WINDOW_MS = 3_600_000; // 1 hour
export const DCR_RATE_LIMIT_MAX = 20; // per IP (/64 for IPv6)
