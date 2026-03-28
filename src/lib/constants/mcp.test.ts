import { describe, it, expect } from "vitest";
import { MCP_SCOPE, MCP_SCOPES } from "./mcp";

describe("MCP_SCOPE", () => {
  it("MCP_SCOPES contains all MCP_SCOPE values", () => {
    const scopeValues = Object.values(MCP_SCOPE);
    expect(MCP_SCOPES).toEqual(expect.arrayContaining(scopeValues));
    expect(MCP_SCOPES.length).toBe(scopeValues.length);
  });

  it("includes credentials:decrypt scope", () => {
    expect(MCP_SCOPES).toContain("credentials:decrypt");
  });
});
