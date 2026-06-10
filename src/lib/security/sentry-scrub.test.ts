import { describe, it, expect } from "vitest";
import { scrubObject, scrubSentryEvent, sanitizeUrl, redactCapabilityPaths, TOKEN_ROUTE_PATTERNS } from "./sentry-scrub";

describe("scrubObject", () => {
  it("redacts top-level sensitive keys", () => {
    const input = {
      username: "alice",
      password: "secret123",
      email: "alice@example.com",
    };
    const result = scrubObject(input) as Record<string, unknown>;
    expect(result.username).toBe("alice");
    expect(result.password).toBe("[Redacted]");
    expect(result.email).toBe("alice@example.com");
  });

  it("redacts nested sensitive keys", () => {
    const input = {
      user: {
        name: "Bob",
        encryptedSecretKey: "abc123",
        settings: {
          authToken: "tok-xyz",
          theme: "dark",
        },
      },
    };
    const result = scrubObject(input) as Record<string, unknown>;
    const user = result.user as Record<string, unknown>;
    expect(user.name).toBe("Bob");
    expect(user.encryptedSecretKey).toBe("[Redacted]");
    const settings = user.settings as Record<string, unknown>;
    expect(settings.authToken).toBe("[Redacted]");
    expect(settings.theme).toBe("dark");
  });

  it("redacts all sensitive patterns", () => {
    const input = {
      password: "x",
      passphrase: "x",
      secretKey: "x",
      apiKey: "x",
      accessToken: "x",
      authHeader: "x",
      mnemonic: "x",
      seedPhrase: "x",
      privateKey: "x",
      pepperValue: "x",
      verifierHmac: "x",
      encryptedBlob: "x",
      ciphertext: "x",
      encryptedData: "x",
      safeField: "visible",
    };
    const result = scrubObject(input) as Record<string, unknown>;
    for (const [key, value] of Object.entries(result)) {
      if (key === "safeField") {
        expect(value).toBe("visible");
      } else {
        expect(value).toBe("[Redacted]");
      }
    }
  });

  it("handles arrays", () => {
    const input = [
      { id: 1, password: "secret" },
      { id: 2, password: "other" },
    ];
    const result = scrubObject(input) as Array<Record<string, unknown>>;
    expect(result[0].id).toBe(1);
    expect(result[0].password).toBe("[Redacted]");
    expect(result[1].id).toBe(2);
    expect(result[1].password).toBe("[Redacted]");
  });

  it("preserves non-sensitive values", () => {
    const input = {
      status: 200,
      message: "OK",
      count: 42,
      active: true,
      tags: ["a", "b"],
    };
    const result = scrubObject(input);
    expect(result).toEqual(input);
  });

  it("handles null and undefined", () => {
    expect(scrubObject(null)).toBeNull();
    expect(scrubObject(undefined)).toBeUndefined();
  });

  it("handles primitives", () => {
    expect(scrubObject("hello")).toBe("hello");
    expect(scrubObject(42)).toBe(42);
    expect(scrubObject(true)).toBe(true);
  });

  it("limits recursion depth", () => {
    // Build deeply nested object
    let obj: Record<string, unknown> = { value: "deep" };
    for (let i = 0; i < 15; i++) {
      obj = { nested: obj };
    }
    const result = scrubObject(obj) as Record<string, unknown>;
    // Should not throw — deeply nested parts become "[Redacted]"
    expect(result).toBeDefined();
  });

  it("does not mutate input", () => {
    const input = { password: "secret", name: "Alice" };
    const copy = { ...input };
    scrubObject(input);
    expect(input).toEqual(copy);
  });
});

describe("scrubSentryEvent", () => {
  it("scrubs extra data", () => {
    const event = {
      extra: {
        userId: "u1",
        encryptedKey: "abc",
      },
    };
    const result = scrubSentryEvent(event);
    expect((result.extra as Record<string, unknown>).userId).toBe("u1");
    expect((result.extra as Record<string, unknown>).encryptedKey).toBe("[Redacted]");
  });

  it("scrubs contexts", () => {
    const event = {
      contexts: {
        vault: {
          status: "locked",
          secretKey: "hidden",
        },
      },
    };
    const result = scrubSentryEvent(event);
    const vault = (result.contexts as Record<string, unknown>).vault as Record<string, unknown>;
    expect(vault.status).toBe("locked");
    expect(vault.secretKey).toBe("[Redacted]");
  });

  it("scrubs breadcrumb data", () => {
    const event = {
      breadcrumbs: [
        {
          category: "api",
          data: { url: "/api/vault", password: "x" },
        },
        {
          category: "ui",
          message: "click",
        },
      ],
    };
    const result = scrubSentryEvent(event);
    const bc0 = result.breadcrumbs![0] as Record<string, unknown>;
    const data = bc0.data as Record<string, unknown>;
    expect(data.url).toBe("/api/vault");
    expect(data.password).toBe("[Redacted]");
    // Breadcrumb without data is preserved
    expect(result.breadcrumbs![1]).toEqual({ category: "ui", message: "click" });
  });

  it("scrubs breadcrumb data in { values: [] } format (Sentry SDK format)", () => {
    const event = {
      breadcrumbs: {
        values: [
          {
            category: "api",
            data: { url: "/api/vault", token: "abc123" },
          },
          {
            category: "ui",
            message: "click",
          },
        ],
      },
    };
    const result = scrubSentryEvent(event);
    const bcs = result.breadcrumbs as { values: Array<Record<string, unknown>> };
    const data = bcs.values[0].data as Record<string, unknown>;
    expect(data.url).toBe("/api/vault");
    expect(data.token).toBe("[Redacted]");
    expect(bcs.values[1]).toEqual({ category: "ui", message: "click" });
  });

  it("scrubs request.data", () => {
    const event = {
      request: {
        url: "/api/vault/setup",
        method: "POST",
        data: {
          accountSalt: "visible",
          encryptedSecretKey: "hidden",
          authHash: "hidden",
        },
      },
    };
    const result = scrubSentryEvent(event);
    const reqData = (result.request as Record<string, unknown>).data as Record<string, unknown>;
    expect(reqData.accountSalt).toBe("visible");
    expect(reqData.encryptedSecretKey).toBe("[Redacted]");
    expect(reqData.authHash).toBe("[Redacted]");
  });

  it("scrubs request.data when it is a JSON string", () => {
    const event = {
      request: {
        url: "/api/vault/setup",
        method: "POST",
        data: JSON.stringify({ username: "alice", password: "secret" }),
      },
    };
    const result = scrubSentryEvent(event);
    const reqData = (result.request as Record<string, unknown>).data as string;
    const parsed = JSON.parse(reqData);
    expect(parsed.username).toBe("alice");
    expect(parsed.password).toBe("[Redacted]");
  });

  it("redacts request.data string when not valid JSON", () => {
    const event = {
      request: {
        url: "/api/vault/setup",
        method: "POST",
        data: "not-json-body",
      },
    };
    const result = scrubSentryEvent(event);
    expect((result.request as Record<string, unknown>).data).toBe("[Redacted]");
  });

  it("scrubs exception.values stacktrace", () => {
    const event = {
      exception: {
        values: [
          {
            type: "Error",
            value: "test",
            stacktrace: {
              frames: [
                {
                  filename: "app.js",
                  vars: { password: "leak", safeVar: "ok" },
                },
              ],
            },
          },
        ],
      },
    };
    const result = scrubSentryEvent(event);
    const exc = result.exception as Record<string, unknown>;
    const values = exc.values as Array<Record<string, unknown>>;
    const st = values[0].stacktrace as Record<string, unknown>;
    const frames = st.frames as Array<Record<string, unknown>>;
    const vars = frames[0].vars as Record<string, unknown>;
    expect(vars.password).toBe("[Redacted]");
    expect(vars.safeVar).toBe("ok");
  });

  it("handles event without optional fields", () => {
    const event = { message: "test error" };
    const result = scrubSentryEvent(event);
    expect(result.message).toBe("test error");
  });
});

// C11 acceptance fixtures — each MUST fail before the sentry-scrub.ts changes
// (red-green verified by stashing sentry-scrub.ts and re-running the suite).
describe("C11 — transaction event scrubbing", () => {
  // (a) sensitive key in spans[].data is redacted
  it("(a) redacts sensitive key in spans[].data", () => {
    const event = {
      spans: [
        {
          op: "db.query",
          data: {
            "db.statement": "SELECT 1",
            password: "secret-value",
            safeField: "visible",
          },
        },
      ],
    };
    const result = scrubSentryEvent(event);
    const spanData = (result.spans as Array<Record<string, unknown>>)[0].data as Record<string, unknown>;
    expect(spanData["db.statement"]).toBe("SELECT 1");
    expect(spanData.safeField).toBe("visible");
    expect(spanData.password).toBe("[Redacted]");
  });

  // (b) http.url with /s/<token> in the PATH is redacted
  it("(b) redacts /s/<token> capability path in http.url span data", () => {
    const token = "abc123xyz456789";
    const event = {
      spans: [
        {
          op: "http.client",
          data: {
            "http.url": `https://example.com/s/${token}`,
            "http.method": "GET",
          },
        },
      ],
    };
    const result = scrubSentryEvent(event);
    const spanData = (result.spans as Array<Record<string, unknown>>)[0].data as Record<string, unknown>;
    expect(spanData["http.url"]).toBe("https://example.com/s/[redacted]");
    expect(spanData["http.method"]).toBe("GET");
  });

  // (c) query-carried token is stripped from request.url
  it("(c) strips query string from request.url (query-carried token)", () => {
    const event = {
      request: {
        url: "https://example.com/api/auth/callback/email?token=magic-link-token-xyz&callbackUrl=%2Fdashboard",
        method: "GET",
      },
    };
    const result = scrubSentryEvent(event);
    const reqUrl = (result.request as Record<string, unknown>).url as string;
    expect(reqUrl).toBe("https://example.com/api/auth/callback/email");
    expect(reqUrl).not.toContain("token=");
  });

  // (d) invite-path token redacted — fixture uses locale-prefixed URL /ja/...
  it("(d) redacts team invite token in locale-prefixed path /ja/dashboard/teams/invite/<token>", () => {
    const inviteToken = "rawInviteToken256bitHex123456789abcdef";
    const event = {
      request: {
        url: `https://example.com/ja/dashboard/teams/invite/${inviteToken}`,
        method: "GET",
      },
    };
    const result = scrubSentryEvent(event);
    const reqUrl = (result.request as Record<string, unknown>).url as string;
    expect(reqUrl).toBe("https://example.com/ja/dashboard/teams/invite/[redacted]");
    expect(reqUrl).not.toContain(inviteToken);
  });

  // (e) fragment #token=... is stripped
  it("(e) strips fragment (#token=...) from request.url", () => {
    const event = {
      request: {
        url: "https://example.com/dashboard/vault/admin-reset#token=reset-capability-token",
        method: "GET",
      },
    };
    const result = scrubSentryEvent(event);
    const reqUrl = (result.request as Record<string, unknown>).url as string;
    expect(reqUrl).toBe("https://example.com/dashboard/vault/admin-reset");
    expect(reqUrl).not.toContain("#token=");
  });
});

// F1 + S2 acceptance fixtures — each MUST fail when the corresponding production lines are commented out.
describe("F1 / S2 — new coverage", () => {
  // F1: navigation breadcrumb from/to must be based on already-scrubbed data (not raw bc.data)
  it("F1: navigation from/to sanitized from scrubbed data — /s/<token> and ?token= removed", () => {
    const event = {
      breadcrumbs: {
        values: [
          {
            category: "navigation",
            data: {
              from: "/s/rawShareToken123",
              to: "/dashboard?token=magicLinkAbc",
              tokenKey: "should-be-redacted",
            },
          },
        ],
      },
    };
    const result = scrubSentryEvent(event);
    const bcs = result.breadcrumbs as { values: Array<Record<string, unknown>> };
    const data = bcs.values[0].data as Record<string, unknown>;
    // from: /s/ token segment redacted
    expect(data.from).toBe("/s/[redacted]");
    // to: query string stripped
    expect(data.to).toBe("/dashboard");
    expect(String(data.to)).not.toContain("token=");
    // sensitive key in data also redacted (scrubObject ran first)
    expect(data.tokenKey).toBe("[Redacted]");
  });

  // S2(a): request.headers Referer with invite path token — path must be redacted
  it("S2(a): request.headers.Referer with team invite path is sanitized", () => {
    const inviteToken = "inviteToken256hexABCDEF";
    const event = {
      request: {
        url: "/dashboard",
        headers: {
          "Content-Type": "application/json",
          Referer: `https://example.com/ja/dashboard/teams/invite/${inviteToken}`,
          "X-Safe-Header": "safe-value",
        },
      },
    };
    const result = scrubSentryEvent(event);
    const headers = (result.request as Record<string, unknown>).headers as Record<string, unknown>;
    expect(headers["Referer"]).toBe("https://example.com/ja/dashboard/teams/invite/[redacted]");
    expect(String(headers["Referer"])).not.toContain(inviteToken);
    // Other headers untouched
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Safe-Header"]).toBe("safe-value");
  });

  // S2(b): span data url.full sanitized, http.target sanitized, url.query wiped, url.path wiped
  it("S2(b): span data url.full with /s/<token> is sanitized", () => {
    const event = {
      spans: [
        {
          op: "http.client",
          data: {
            "url.full": "https://example.com/s/shareTokenXYZ?utm=1",
            "http.target": "/s/shareTokenXYZ?utm=1",
            "url.query": "token=abc&foo=bar",
            "url.path": "/s/shareTokenXYZ",
            "http.method": "GET",
          },
        },
      ],
    };
    const result = scrubSentryEvent(event);
    const spanData = (result.spans as Array<Record<string, unknown>>)[0].data as Record<string, unknown>;
    // url.full: query stripped + path token redacted
    expect(spanData["url.full"]).toBe("https://example.com/s/[redacted]");
    // http.target: same treatment
    expect(spanData["http.target"]).toBe("/s/[redacted]");
    // url.query: wiped entirely
    expect(spanData["url.query"]).toBe("");
    // url.path: wiped entirely
    expect(spanData["url.path"]).toBe("");
    // other keys untouched
    expect(spanData["http.method"]).toBe("GET");
  });

  // S2(c): fetch-category breadcrumb data.url with token path is sanitized
  it("S2(c): fetch breadcrumb data.url with /s/<token> is sanitized", () => {
    const event = {
      breadcrumbs: [
        {
          category: "fetch",
          data: {
            url: "https://example.com/s/fetchToken999?q=1",
            method: "GET",
          },
        },
      ],
    };
    const result = scrubSentryEvent(event);
    const bc = result.breadcrumbs![0] as Record<string, unknown>;
    const data = bc.data as Record<string, unknown>;
    expect(data.url).toBe("https://example.com/s/[redacted]");
    expect(String(data.url)).not.toContain("fetchToken999");
    expect(data.method).toBe("GET");
  });

  // S2(d): contexts.trace.data sensitive key + url.full sanitized
  it("S2(d): contexts.trace.data sensitive key redacted and url.full sanitized", () => {
    const event = {
      contexts: {
        trace: {
          op: "http.server",
          data: {
            "url.full": "https://example.com/s/traceToken111?x=y",
            "http.method": "GET",
            secretKey: "trace-secret-value",
          },
        },
      },
    };
    const result = scrubSentryEvent(event);
    const trace = ((result.contexts as Record<string, unknown>).trace as Record<string, unknown>);
    const data = trace.data as Record<string, unknown>;
    // url.full: sanitized
    expect(data["url.full"]).toBe("https://example.com/s/[redacted]");
    expect(String(data["url.full"])).not.toContain("traceToken111");
    // secretKey: redacted
    expect(data.secretKey).toBe("[Redacted]");
    // safe key: preserved
    expect(data["http.method"]).toBe("GET");
  });
});

describe("sanitizeUrl", () => {
  it("strips query string", () => {
    expect(sanitizeUrl("https://example.com/path?foo=bar&baz=qux")).toBe("https://example.com/path");
  });

  it("strips fragment", () => {
    expect(sanitizeUrl("https://example.com/path#section")).toBe("https://example.com/path");
  });

  it("strips both query and fragment", () => {
    expect(sanitizeUrl("https://example.com/path?q=1#frag")).toBe("https://example.com/path");
  });

  it("redacts /s/<token> path segment", () => {
    expect(sanitizeUrl("https://app.example.com/s/abc123token")).toBe("https://app.example.com/s/[redacted]");
  });

  it("redacts emergency-access invite token", () => {
    expect(sanitizeUrl("https://app.example.com/en/dashboard/emergency-access/invite/TOKEN_VALUE")).toBe(
      "https://app.example.com/en/dashboard/emergency-access/invite/[redacted]"
    );
  });

  it("TOKEN_ROUTE_PATTERNS is exported and non-empty", () => {
    expect(TOKEN_ROUTE_PATTERNS.length).toBeGreaterThan(0);
  });
});

// S6 acceptance fixtures — capability URLs inside free-text fields
// (exception.values[].value and event.message) must be partially redacted
// via redactCapabilityPaths only; ?/# and surrounding text must survive.
describe("S6 — capability URL redaction in free-text fields", () => {
  it("redactCapabilityPaths replaces /s/<token> in free text, leaving ?/# intact", () => {
    const input = "fetch https://x.example.com/s/capToken123?retry=1 failed with 404";
    const result = redactCapabilityPaths(input);
    expect(result).toBe("fetch https://x.example.com/s/[redacted]?retry=1 failed with 404");
    expect(result).not.toContain("capToken123");
    // query string and surrounding text must survive
    expect(result).toContain("?retry=1");
    expect(result).toContain("failed with 404");
  });

  it("exception.values[].value with capability URL is partially redacted", () => {
    const token = "exceptionCapToken";
    const event = {
      exception: {
        values: [
          {
            type: "FetchError",
            value: `fetch https://app.example.com/s/${token} failed: network error`,
            stacktrace: { frames: [] },
          },
        ],
      },
    };
    const result = scrubSentryEvent(event);
    const exc = result.exception as Record<string, unknown>;
    const values = exc.values as Array<Record<string, unknown>>;
    expect(values[0].value).toBe("fetch https://app.example.com/s/[redacted] failed: network error");
    expect(String(values[0].value)).not.toContain(token);
    // surrounding text survives
    expect(String(values[0].value)).toContain("failed: network error");
  });

  it("event.message with capability URL is partially redacted", () => {
    const token = "msgCapToken456";
    const event = {
      message: `Error loading https://app.example.com/s/${token}: 403 Forbidden`,
    };
    const result = scrubSentryEvent(event);
    expect(result.message).toBe("Error loading https://app.example.com/s/[redacted]: 403 Forbidden");
    expect(String(result.message)).not.toContain(token);
    // surrounding text survives
    expect(String(result.message)).toContain("403 Forbidden");
  });

  it("exception.values[].value without capability URL is unchanged", () => {
    const event = {
      exception: {
        values: [
          { type: "Error", value: "Cannot read property of undefined", stacktrace: null },
        ],
      },
    };
    const result = scrubSentryEvent(event);
    const exc = result.exception as Record<string, unknown>;
    const values = exc.values as Array<Record<string, unknown>>;
    expect(values[0].value).toBe("Cannot read property of undefined");
  });

  it("event.message without capability URL is unchanged", () => {
    const event = { message: "Application started successfully" };
    const result = scrubSentryEvent(event);
    expect(result.message).toBe("Application started successfully");
  });
});
