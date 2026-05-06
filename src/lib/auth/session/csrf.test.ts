import { describe, expect, it, vi } from "vitest";
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

// setup.ts wires `vi.unstubAllEnvs()` in afterEach, so any vi.stubEnv()
// here is reverted between tests automatically.

describe("assertOrigin", () => {
  it("returns null (pass) when origin matches APP_URL", () => {
    vi.stubEnv("APP_URL", "http://localhost:3000");
    const result = assertOrigin(makeRequest("http://localhost:3000"));
    expect(result).toBeNull();
  });

  it("returns null when origin matches AUTH_URL (fallback)", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    const result = assertOrigin(makeRequest("http://localhost:3000"));
    expect(result).toBeNull();
  });

  it("returns 403 when APP_URL and AUTH_URL are both unset even if Host matches", async () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("AUTH_URL", "");
    const result = assertOrigin(
      makeRequest("http://localhost:3000", { host: "localhost:3000" }),
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 when origin differs from Host and APP_URL/AUTH_URL are unset", async () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("AUTH_URL", "");
    const result = assertOrigin(
      makeRequest("http://evil.com", { host: "localhost:3000" }),
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 when x-forwarded-proto suggests https but canonical origin is unset", async () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("AUTH_URL", "");
    const result = assertOrigin(
      makeRequest("https://localhost:3000", {
        host: "localhost:3000",
        "x-forwarded-proto": "https",
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 when origin is missing even if APP_URL/AUTH_URL are unset", async () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("AUTH_URL", "");
    const result = assertOrigin(makeRequest(undefined, { host: "localhost:3000" }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 when origin and Host are both missing and APP_URL is unset", async () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("AUTH_URL", "");
    const result = assertOrigin(makeRequest());
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 when origin is missing and APP_URL is set", async () => {
    vi.stubEnv("APP_URL", "http://localhost:3000");
    const result = assertOrigin(makeRequest());
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    const body = await result!.json();
    expect(body.error).toBe("INVALID_ORIGIN");
  });

  it("returns 403 when origin does not match", async () => {
    vi.stubEnv("APP_URL", "http://localhost:3000");
    const result = assertOrigin(makeRequest("http://evil.com"));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 for malformed origin", async () => {
    vi.stubEnv("APP_URL", "http://localhost:3000");
    const result = assertOrigin(makeRequest("not-a-url"));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("matches origin ignoring path in APP_URL", () => {
    vi.stubEnv("APP_URL", "http://localhost:3000/some/path");
    const result = assertOrigin(makeRequest("http://localhost:3000"));
    expect(result).toBeNull();
  });
});
