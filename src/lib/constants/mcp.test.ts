import { describe, it, expect } from "vitest";
import { MCP_SCOPE, MCP_SCOPES } from "./mcp";

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
