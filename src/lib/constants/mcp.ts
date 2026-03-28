export const MCP_TOKEN_PREFIX = "mcp_";
export const MCP_CLIENT_ID_PREFIX = "mcpc_";

// MCP scope values (subset of SA scopes, read-only for safety)
export const MCP_SCOPE = {
  CREDENTIALS_READ: "credentials:read",
  CREDENTIALS_LIST: "credentials:list",
  TEAM_CREDENTIALS_READ: "team:credentials:read",
  VAULT_STATUS: "vault:status",
  CREDENTIALS_DECRYPT: "credentials:decrypt",
} as const;

export type McpScope = (typeof MCP_SCOPE)[keyof typeof MCP_SCOPE];
export const MCP_SCOPES = Object.values(MCP_SCOPE) as McpScope[];

// OAuth 2.1 constants
export const MCP_CODE_EXPIRY_SEC = 300; // 5 minutes
export const MCP_TOKEN_EXPIRY_SEC = 3600; // 1 hour
export const MCP_TOKEN_MAX_EXPIRY_SEC = 86400; // 24 hours

// Limits
export const MAX_MCP_CLIENTS_PER_TENANT = 10;
export const MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

// MCP protocol
export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const MCP_SERVER_NAME = "passwd-sso";
export const MCP_SERVER_VERSION = "1.0.0";
