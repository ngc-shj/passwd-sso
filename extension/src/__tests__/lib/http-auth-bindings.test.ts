import { describe, it, expect, vi, afterEach } from "vitest";
import {
  HTTP_AUTH_BINDINGS_KEY,
  getBinding,
  isPendingIntent,
  listBindings,
  normalizeOrigin,
  patternCovers,
  releasePermissions,
  removeBinding,
  setBinding,
} from "../../lib/http-auth-bindings";

describe("normalizeOrigin", () => {
  it.each([
    ["drops path, query and fragment", "https://example.com/login?next=/#top", "https://example.com"],
    ["lowercases the host and keeps the scheme", "HTTPS://Example.COM/", "https://example.com"],
    ["omits the default https port", "https://example.com:443/", "https://example.com"],
    ["omits the default http port", "http://router.local:80/", "http://router.local"],
    ["keeps a non-default port", "http://10.0.0.1:8080/basic-auth/u/p", "http://10.0.0.1:8080"],
    ["keeps https on port 80 distinct from http", "https://example.com:80/", "https://example.com:80"],
    ["brackets an IPv6 host", "http://[::1]:3000/x", "http://[::1]:3000"],
    ["drops userinfo", "https://user:pw@example.com/", "https://example.com"],
    ["encodes an IDN host as punycode", "https://bücher.example/", "https://xn--bcher-kva.example"],
  ])("%s", (_name, input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });

  it.each([
    ["an empty string", ""],
    ["a bare host", "example.com"],
    ["a relative path", "/login"],
    ["an ftp URL", "ftp://example.com/"],
    ["a file URL", "file:///etc/passwd"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a data URL", "data:text/html,hi"],
    ["a chrome-extension URL", "chrome-extension://abc/popup.html"],
    ["an http URL without a host", "http://"],
  ])("returns null for %s", (_name, input) => {
    expect(normalizeOrigin(input)).toBeNull();
  });
});

// ── C2 store and C5 release ─────────────────────────────────────

function installChrome(serverUrl = "https://server.example") {
  const local: Record<string, unknown> = {};
  const chromeMock = {
    storage: {
      local: {
        // A key read answers that key; getSettings reads with its DEFAULTS object.
        get: vi.fn(async (keys: unknown) =>
          typeof keys === "string" ? { [keys]: local[keys] } : { ...(keys as object), serverUrl },
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(local, items);
        }),
      },
    },
    permissions: { remove: vi.fn(async () => true) },
  };
  vi.stubGlobal("chrome", chromeMock);
  return { chromeMock, local };
}

const removedOrigins = (remove: ReturnType<typeof vi.fn>) =>
  remove.mock.calls.flatMap(([arg]) => (arg as { origins?: string[] }).origins ?? []);
const removedApis = (remove: ReturnType<typeof vi.fn>) =>
  remove.mock.calls.flatMap(([arg]) => (arg as { permissions?: string[] }).permissions ?? []);

describe("binding store", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("drops malformed records and keeps valid ones", async () => {
    const { local } = installChrome();
    local[HTTP_AUTH_BINDINGS_KEY] = [
      { origin: "https://ok.example", entryId: "e1" },
      { origin: "https://ok.example/path", entryId: "e2" },
      { origin: "ftp://x.example", entryId: "e3" },
      { origin: "https://bad-id.example", entryId: "../etc" },
      { origin: "https://team.example", entryId: "e4", teamId: "t1" },
      { origin: "https://bad-team.example", entryId: "e5", teamId: 7 },
      null,
      "https://raw.example",
      { origin: "https://ok.example", entryId: "duplicate" },
    ];

    expect(await listBindings()).toEqual([
      { origin: "https://ok.example", entryId: "e1" },
      { origin: "https://team.example", entryId: "e4", teamId: "t1" },
    ]);
  });

  it("reads a non-array value as no bindings", async () => {
    const { local } = installChrome();
    local[HTTP_AUTH_BINDINGS_KEY] = { origin: "https://ok.example", entryId: "e1" };
    expect(await listBindings()).toEqual([]);
  });

  it("setBinding replaces the binding for the same origin and keeps others", async () => {
    installChrome();
    await setBinding({ origin: "https://a.example", entryId: "e1" });
    await setBinding({ origin: "https://b.example", entryId: "e2" });
    await setBinding({ origin: "https://a.example", entryId: "e3", teamId: "t1" });

    expect(await listBindings()).toEqual([
      { origin: "https://b.example", entryId: "e2" },
      { origin: "https://a.example", entryId: "e3", teamId: "t1" },
    ]);
    expect(await getBinding("https://a.example")).toEqual({ origin: "https://a.example", entryId: "e3", teamId: "t1" });
  });

  it("setBinding refuses a non-normalized origin", async () => {
    installChrome();
    await expect(setBinding({ origin: "https://A.example/", entryId: "e1" })).rejects.toThrow();
    expect(await listBindings()).toEqual([]);
  });

  it("removeBinding removes only that origin", async () => {
    installChrome();
    await setBinding({ origin: "https://a.example", entryId: "e1" });
    await setBinding({ origin: "https://b.example", entryId: "e2" });
    await removeBinding("https://a.example");
    expect(await listBindings()).toEqual([{ origin: "https://b.example", entryId: "e2" }]);
  });
});

describe("patternCovers", () => {
  it.each([
    ["a portless pattern covers any port of its host", "http://localhost", "http://localhost:3001", true],
    ["a portless pattern covers the default port", "https://h.example", "https://h.example", true],
    ["a pattern with a port covers that port", "http://h.example:8080", "http://h.example:8080", true],
    ["a pattern with a port does not cover another port", "http://h.example:8080", "http://h.example:8081", false],
    ["a pattern with a port does not cover the default port", "http://h.example:8080", "http://h.example", false],
    ["the scheme must match", "https://h.example", "http://h.example", false],
    ["the host must match exactly", "https://h.example", "https://sub.h.example", false],
  ])("%s", (_name, pattern, origin, expected) => {
    expect(patternCovers(pattern, origin)).toBe(expected);
  });
});

describe("releasePermissions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("removes the origin pattern and the API permissions when nothing needs them", async () => {
    const { chromeMock } = installChrome();
    await releasePermissions("https://a.example");
    expect(removedOrigins(chromeMock.permissions.remove)).toEqual(["https://a.example/*"]);
    expect(removedApis(chromeMock.permissions.remove)).toEqual(["webRequest", "webRequestAuthProvider"]);
  });

  it("keeps a portless pattern another binding on another port needs", async () => {
    const { chromeMock } = installChrome();
    await setBinding({ origin: "http://nas.example:5000", entryId: "e2" });
    await releasePermissions("http://nas.example");
    expect(removedOrigins(chromeMock.permissions.remove)).toEqual([]);
  });

  it("control: removes a pattern with a port another port's binding does not need", async () => {
    const { chromeMock } = installChrome();
    await setBinding({ origin: "http://nas.example", entryId: "e2" });
    await releasePermissions("http://nas.example:5000");
    expect(removedOrigins(chromeMock.permissions.remove)).toEqual(["http://nas.example:5000/*"]);
  });

  it("keeps the pattern that covers the configured server origin", async () => {
    const { chromeMock } = installChrome("http://localhost:3001/app");
    await releasePermissions("http://localhost");
    expect(removedOrigins(chromeMock.permissions.remove)).toEqual([]);
  });

  it("control: removes a pattern that does not cover the server origin", async () => {
    const { chromeMock } = installChrome("http://localhost:3001/app");
    await releasePermissions("http://localhost:8080");
    expect(removedOrigins(chromeMock.permissions.remove)).toEqual(["http://localhost:8080/*"]);
  });

  it("keeps the API permissions while any binding remains", async () => {
    const { chromeMock } = installChrome();
    await setBinding({ origin: "https://b.example", entryId: "e2" });
    await releasePermissions("https://a.example");
    expect(removedOrigins(chromeMock.permissions.remove)).toEqual(["https://a.example/*"]);
    expect(removedApis(chromeMock.permissions.remove)).toEqual([]);
  });

  it("logs and goes on when a remove throws", async () => {
    const { chromeMock } = installChrome();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    chromeMock.permissions.remove.mockRejectedValueOnce(new Error("You cannot remove required permissions."));
    await expect(releasePermissions("https://a.example")).resolves.toBeUndefined();
    expect(removedApis(chromeMock.permissions.remove)).toEqual(["webRequest", "webRequestAuthProvider"]);
    expect(warn).toHaveBeenCalledWith("[passwd-sso] http-auth-permission-remove-failed: error");
    warn.mockRestore();
  });
});

describe("isPendingIntent", () => {
  const intent = { nonce: "n1", origin: "https://a.example", entryId: "e1", expiresAt: 1 };
  it.each([
    ["a complete intent", intent, true],
    ["a team intent", { ...intent, teamId: "t1" }, true],
    ["no nonce", { ...intent, nonce: "" }, false],
    ["no expiry", { ...intent, expiresAt: undefined }, false],
    ["a non-normalized origin", { ...intent, origin: "https://a.example/" }, false],
    ["a bad entry id", { ...intent, entryId: "a b" }, false],
    ["null", null, false],
  ])("%s", (_name, value, expected) => {
    expect(isPendingIntent(value)).toBe(expected);
  });
});
