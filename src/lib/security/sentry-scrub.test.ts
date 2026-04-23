import { describe, it, expect } from "vitest";
import { scrubObject, scrubSentryEvent } from "./sentry-scrub";

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
