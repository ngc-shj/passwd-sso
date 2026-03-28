import { describe, expect, it } from "vitest";
import {
  parseScope,
  parseScopes,
  scopeSatisfies,
  scopeStringSatisfies,
} from "./scope-parser";

describe("parseScope", () => {
  it("parses simple resource:action", () => {
    const result = parseScope("passwords:read");
    expect(result).toEqual({
      resource: "passwords",
      action: "read",
      qualifier: undefined,
      raw: "passwords:read",
    });
  });

  it("parses resource:action:qualifier", () => {
    const result = parseScope("passwords:read:folder/550e8400-e29b-41d4-a716-446655440000");
    expect(result).toEqual({
      resource: "passwords",
      action: "read",
      qualifier: "folder/550e8400-e29b-41d4-a716-446655440000",
      raw: "passwords:read:folder/550e8400-e29b-41d4-a716-446655440000",
    });
  });

  it("parses team-scoped scope", () => {
    const result = parseScope("team:550e8400-e29b-41d4-a716-446655440000:passwords:read");
    expect(result).toEqual({
      resource: "team:550e8400-e29b-41d4-a716-446655440000:passwords",
      action: "read",
      qualifier: undefined,
      raw: "team:550e8400-e29b-41d4-a716-446655440000:passwords:read",
    });
  });

  it("returns null for malformed scope", () => {
    expect(parseScope("invalid")).toBeNull();
  });

  it("returns null for invalid qualifier type", () => {
    expect(parseScope("passwords:read:user/550e8400-e29b-41d4-a716-446655440000")).toBeNull();
  });

  it("returns null for invalid qualifier uuid", () => {
    expect(parseScope("passwords:read:folder/not-a-uuid")).toBeNull();
  });

  it("returns null for invalid team UUID", () => {
    expect(parseScope("team:not-a-uuid:passwords:read")).toBeNull();
  });
});

describe("parseScopes", () => {
  it("parses CSV scope string", () => {
    const result = parseScopes("passwords:read,tags:read");
    expect(result).toHaveLength(2);
    expect(result[0].raw).toBe("passwords:read");
    expect(result[1].raw).toBe("tags:read");
  });

  it("drops invalid scopes silently", () => {
    const result = parseScopes("passwords:read,invalid,tags:read");
    expect(result).toHaveLength(2);
  });

  it("handles empty string", () => {
    expect(parseScopes("")).toEqual([]);
  });

  it("trims whitespace", () => {
    const result = parseScopes(" passwords:read , tags:read ");
    expect(result).toHaveLength(2);
  });
});

describe("scopeSatisfies", () => {
  it("unqualified grant covers qualified requirement", () => {
    const granted = parseScopes("passwords:read");
    const required = parseScope("passwords:read:folder/550e8400-e29b-41d4-a716-446655440000")!;
    expect(scopeSatisfies(granted, required)).toBe(true);
  });

  it("unqualified grant covers unqualified requirement", () => {
    const granted = parseScopes("passwords:read");
    const required = parseScope("passwords:read")!;
    expect(scopeSatisfies(granted, required)).toBe(true);
  });

  it("qualified grant does NOT cover unqualified requirement", () => {
    const granted = parseScopes("passwords:read:folder/550e8400-e29b-41d4-a716-446655440000");
    const required = parseScope("passwords:read")!;
    expect(scopeSatisfies(granted, required)).toBe(false);
  });

  it("exact qualifier match satisfies", () => {
    const folderId = "550e8400-e29b-41d4-a716-446655440000";
    const granted = parseScopes(`passwords:read:folder/${folderId}`);
    const required = parseScope(`passwords:read:folder/${folderId}`)!;
    expect(scopeSatisfies(granted, required)).toBe(true);
  });

  it("different qualifier does not satisfy", () => {
    const granted = parseScopes("passwords:read:folder/550e8400-e29b-41d4-a716-446655440000");
    const required = parseScope("passwords:read:folder/660e8400-e29b-41d4-a716-446655440001")!;
    expect(scopeSatisfies(granted, required)).toBe(false);
  });

  it("different action does not satisfy", () => {
    const granted = parseScopes("passwords:read");
    const required = parseScope("passwords:write")!;
    expect(scopeSatisfies(granted, required)).toBe(false);
  });

  it("different resource does not satisfy", () => {
    const granted = parseScopes("passwords:read");
    const required = parseScope("tags:read")!;
    expect(scopeSatisfies(granted, required)).toBe(false);
  });

  it("team-scoped unqualified grant covers team-scoped qualified requirement", () => {
    const teamId = "550e8400-e29b-41d4-a716-446655440000";
    const folderId = "660e8400-e29b-41d4-a716-446655440001";
    const granted = parseScopes(`team:${teamId}:passwords:read`);
    const required = parseScope(`team:${teamId}:passwords:read:folder/${folderId}`)!;
    expect(scopeSatisfies(granted, required)).toBe(true);
  });

  it("different team UUIDs do not satisfy each other", () => {
    const teamA = "550e8400-e29b-41d4-a716-446655440000";
    const teamB = "660e8400-e29b-41d4-a716-446655440001";
    const granted = parseScopes(`team:${teamA}:passwords:read`);
    const required = parseScope(`team:${teamB}:passwords:read`)!;
    expect(scopeSatisfies(granted, required)).toBe(false);
  });
});

describe("scopeStringSatisfies", () => {
  it("convenience wrapper works", () => {
    expect(scopeStringSatisfies("passwords:read,tags:read", "tags:read")).toBe(true);
    expect(scopeStringSatisfies("passwords:read", "tags:read")).toBe(false);
  });

  it("returns false for invalid required scope", () => {
    expect(scopeStringSatisfies("passwords:read", "invalid")).toBe(false);
  });
});
