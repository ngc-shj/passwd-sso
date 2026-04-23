import { describe, it, expect } from "vitest";
import { parseApiKeyScopes, hasApiKeyScope } from "./api-key";

describe("parseApiKeyScopes", () => {
  it("parses valid CSV scopes", () => {
    expect(parseApiKeyScopes("passwords:read,tags:read")).toEqual([
      "passwords:read",
      "tags:read",
    ]);
  });

  it("drops unknown scopes", () => {
    expect(parseApiKeyScopes("passwords:read,admin:delete")).toEqual([
      "passwords:read",
    ]);
  });

  it("handles empty string", () => {
    expect(parseApiKeyScopes("")).toEqual([]);
  });

  it("handles whitespace in CSV", () => {
    expect(parseApiKeyScopes(" passwords:read , tags:read ")).toEqual([
      "passwords:read",
      "tags:read",
    ]);
  });

  it("handles single scope", () => {
    expect(parseApiKeyScopes("vault:status")).toEqual(["vault:status"]);
  });
});

describe("hasApiKeyScope", () => {
  it("returns true when scope is present", () => {
    expect(hasApiKeyScope(["passwords:read", "tags:read"], "passwords:read")).toBe(true);
  });

  it("returns false when scope is absent", () => {
    expect(hasApiKeyScope(["passwords:read"], "passwords:write")).toBe(false);
  });

  it("returns false for empty scopes array", () => {
    expect(hasApiKeyScope([], "passwords:read")).toBe(false);
  });
});
