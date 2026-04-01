import { describe, it, expect } from "vitest";
import { MCP_SCOPE, MCP_SCOPES, MCP_SCOPE_RISK, MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS } from "./mcp";

describe("MCP_SCOPE", () => {
  it("MCP_SCOPES contains all MCP_SCOPE values", () => {
    const scopeValues = Object.values(MCP_SCOPE);
    expect(MCP_SCOPES).toEqual(expect.arrayContaining(scopeValues));
    expect(MCP_SCOPES.length).toBe(scopeValues.length);
  });

  it("includes credentials:list scope", () => {
    expect(MCP_SCOPES).toContain(MCP_SCOPE.CREDENTIALS_LIST);
    expect(MCP_SCOPE.CREDENTIALS_LIST).toBe("credentials:list");
  });

  it("includes credentials:use scope", () => {
    expect(MCP_SCOPES).toContain(MCP_SCOPE.CREDENTIALS_USE);
    expect(MCP_SCOPE.CREDENTIALS_USE).toBe("credentials:use");
  });

  it("includes credentials:decrypt legacy scope", () => {
    expect(MCP_SCOPES).toContain(MCP_SCOPE.CREDENTIALS_DECRYPT);
    expect(MCP_SCOPE.CREDENTIALS_DECRYPT).toBe("credentials:decrypt");
  });
});

describe("MCP_SCOPE_RISK", () => {
  it("every MCP_SCOPE value has a risk level entry", () => {
    for (const scope of MCP_SCOPES) {
      expect(MCP_SCOPE_RISK).toHaveProperty(scope);
    }
  });

  it("risk map has exactly as many entries as MCP_SCOPES", () => {
    expect(Object.keys(MCP_SCOPE_RISK).length).toBe(MCP_SCOPES.length);
  });

  it("credentials:list is risk level 'read'", () => {
    expect(MCP_SCOPE_RISK[MCP_SCOPE.CREDENTIALS_LIST]).toBe("read");
  });

  it("vault:status is risk level 'read'", () => {
    expect(MCP_SCOPE_RISK[MCP_SCOPE.VAULT_STATUS]).toBe("read");
  });

  it("credentials:use is risk level 'use'", () => {
    expect(MCP_SCOPE_RISK[MCP_SCOPE.CREDENTIALS_USE]).toBe("use");
  });

  it("passwords:read is risk level 'use'", () => {
    expect(MCP_SCOPE_RISK[MCP_SCOPE.PASSWORDS_READ]).toBe("use");
  });

  it("vault:unlock-data is risk level 'use'", () => {
    expect(MCP_SCOPE_RISK[MCP_SCOPE.VAULT_UNLOCK_DATA]).toBe("use");
  });

  it("team:credentials:read is risk level 'use'", () => {
    expect(MCP_SCOPE_RISK[MCP_SCOPE.TEAM_CREDENTIALS_READ]).toBe("use");
  });

  it("passwords:write is risk level 'write'", () => {
    expect(MCP_SCOPE_RISK[MCP_SCOPE.PASSWORDS_WRITE]).toBe("write");
  });

  it("credentials:decrypt (legacy) is risk level 'write'", () => {
    expect(MCP_SCOPE_RISK[MCP_SCOPE.CREDENTIALS_DECRYPT]).toBe("write");
  });
});

describe("MCP token constants", () => {
  it("MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS is a positive number", () => {
    expect(MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS)).toBe(true);
  });
});
