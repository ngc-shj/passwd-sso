import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { assertOrigin } from "./csrf";

function makeRequest(origin?: string): Request {
  const headers: Record<string, string> = {};
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

  it("returns null when APP_URL is not configured (dev convenience)", () => {
    delete process.env.APP_URL;
    delete process.env.AUTH_URL;
    const result = assertOrigin(makeRequest("http://evil.com"));
    expect(result).toBeNull();
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
