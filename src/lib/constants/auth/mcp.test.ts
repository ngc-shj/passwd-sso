import { describe, it, expect } from "vitest";
import {
  MCP_SCOPE,
  MCP_SCOPES,
  MCP_SCOPE_RISK,
  MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS,
  isAcceptableRedirectUri,
  REDIRECT_URI_ACCEPT_SET_MESSAGE,
} from "./mcp";

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

  it("delegation:check is risk level 'use'", () => {
    expect(MCP_SCOPE_RISK[MCP_SCOPE.DELEGATION_CHECK]).toBe("use");
  });

  it("ssh:sign is risk level 'use'", () => {
    expect(MCP_SCOPE_RISK[MCP_SCOPE.SSH_SIGN]).toBe("use");
  });

  it("MCP_SCOPE.SSH_SIGN equals 'ssh:sign'", () => {
    expect(MCP_SCOPE.SSH_SIGN).toBe("ssh:sign");
  });
});

describe("MCP token constants", () => {
  it("MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS is a positive number", () => {
    expect(MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS)).toBe(true);
  });
});

describe("isAcceptableRedirectUri", () => {
  // The one predicate for "is this redirect URI one we will send a user to".
  // Registration uses it to refuse a bad URI; authorize/consent use it again
  // on the STORED value, which is what makes the narrowing reach rows written
  // before it. Both arms are pinned here so neither can be removed quietly.
  it.each([
    ["https://client.example/callback"],
    ["http://127.0.0.1:8765/callback"],
    ["http://localhost:3000/callback"],
  ])("accepts %s", (uri) => {
    expect(isAcceptableRedirectUri(uri)).toBe(true);
  });

  // CSP3's host-source grammar has no IPv6-literal production, so
  // `http://[::1]:*` in form-action is discarded by the browser. Registering
  // one would let consent complete, write an authorization audit row, and
  // never deliver the redirect. See the C9 note in mcp.ts.
  it.each([
    ["http://[::1]:8765/callback"],
    ["http://[::1]/callback"],
  ])("refuses the IPv6 literal loopback %s", (uri) => {
    expect(isAcceptableRedirectUri(uri)).toBe(false);
  });

  it.each([
    ["http://127.0.0.1/callback"], // no port
    ["http://evil.example/callback"], // plain http, not loopback
    ["http://127.0.0.1:8765"], // no trailing path
    ["not-a-url"],
    [""],
  ])("refuses %s", (uri) => {
    expect(isAcceptableRedirectUri(uri)).toBe(false);
  });

  it("does not throw on an unparseable input", () => {
    expect(() => isAcceptableRedirectUri("http://[")).not.toThrow();
  });
});

describe("REDIRECT_URI_ACCEPT_SET_MESSAGE", () => {
  // The message is the only place a rejected client learns WHY, and the whole
  // point of narrowing at registration rather than at consent is that the
  // failure explains itself. Pin both halves.
  it("names the IPv6 literal as the thing being refused", () => {
    expect(REDIRECT_URI_ACCEPT_SET_MESSAGE).toContain("[::1]");
  });

  it("names the alternative the client should use instead", () => {
    expect(REDIRECT_URI_ACCEPT_SET_MESSAGE).toContain("127.0.0.1");
  });

  // If the prose ever advertises a host the predicate refuses, the form tells
  // the admin one thing and the validator does another — the exact defect the
  // i18n hint had before this change.
  it("advertises no host the predicate would refuse", () => {
    for (const host of ["localhost", "127.0.0.1"]) {
      expect(REDIRECT_URI_ACCEPT_SET_MESSAGE).toContain(host);
      expect(isAcceptableRedirectUri(`http://${host}:3000/cb`)).toBe(true);
    }
  });
});
