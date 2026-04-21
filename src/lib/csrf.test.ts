import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { assertOrigin } from "./csrf";

function makeRequest(
  origin?: string,
  extraHeaders: Record<string, string> = {},
): Request {
  const headers: Record<string, string> = { ...extraHeaders };
  if (origin) headers["origin"] = origin;
  return new Request("http://localhost:3000/api/vault/reset", {
    method: "POST",
    headers,
  });
}

describe("assertOrigin", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns null (pass) when origin matches APP_URL", () => {
    process.env.APP_URL = "http://localhost:3000";
    const result = assertOrigin(makeRequest("http://localhost:3000"));
    expect(result).toBeNull();
  });

  it("returns null when origin matches AUTH_URL (fallback)", () => {
    delete process.env.APP_URL;
    process.env.AUTH_URL = "http://localhost:3000";
    const result = assertOrigin(makeRequest("http://localhost:3000"));
    expect(result).toBeNull();
  });

  it("returns null when origin matches Host header (APP_URL/AUTH_URL unset)", () => {
    delete process.env.APP_URL;
    delete process.env.AUTH_URL;
    const result = assertOrigin(
      makeRequest("http://localhost:3000", { host: "localhost:3000" }),
    );
    expect(result).toBeNull();
  });

  it("returns 403 when origin differs from Host (APP_URL/AUTH_URL unset)", async () => {
    delete process.env.APP_URL;
    delete process.env.AUTH_URL;
    const result = assertOrigin(
      makeRequest("http://evil.com", { host: "localhost:3000" }),
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 when origin is missing even if APP_URL/AUTH_URL are unset", async () => {
    delete process.env.APP_URL;
    delete process.env.AUTH_URL;
    const result = assertOrigin(makeRequest(undefined, { host: "localhost:3000" }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 when origin and Host are both missing and APP_URL is unset", async () => {
    delete process.env.APP_URL;
    delete process.env.AUTH_URL;
    const result = assertOrigin(makeRequest());
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 when origin is missing and APP_URL is set", async () => {
    process.env.APP_URL = "http://localhost:3000";
    const result = assertOrigin(makeRequest());
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    const body = await result!.json();
    expect(body.error).toBe("INVALID_ORIGIN");
  });

  it("returns 403 when origin does not match", async () => {
    process.env.APP_URL = "http://localhost:3000";
    const result = assertOrigin(makeRequest("http://evil.com"));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 for malformed origin", async () => {
    process.env.APP_URL = "http://localhost:3000";
    const result = assertOrigin(makeRequest("not-a-url"));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("matches origin ignoring path in APP_URL", () => {
    process.env.APP_URL = "http://localhost:3000/some/path";
    const result = assertOrigin(makeRequest("http://localhost:3000"));
    expect(result).toBeNull();
  });
});
