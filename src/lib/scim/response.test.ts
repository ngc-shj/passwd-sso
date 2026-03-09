import { describe, it, expect, afterEach } from "vitest";
import { scimResponse, scimError, scimListResponse, getScimBaseUrl } from "./response";

describe("scimResponse", () => {
  it("sets Content-Type to application/scim+json", async () => {
    const res = scimResponse({ ok: true });
    expect(res.headers.get("content-type")).toBe("application/scim+json");
  });

  it("defaults to 200 status", () => {
    const res = scimResponse({ ok: true });
    expect(res.status).toBe(200);
  });

  it("supports custom status", () => {
    const res = scimResponse({ created: true }, 201);
    expect(res.status).toBe(201);
  });
});

describe("scimError", () => {
  it("returns SCIM error format with schemas array", async () => {
    const res = scimError(409, "User exists", "uniqueness");
    const body = await res.json();
    expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    expect(body.status).toBe("409");
    expect(body.detail).toBe("User exists");
    expect(body.scimType).toBe("uniqueness");
  });

  it("omits scimType when not provided", async () => {
    const res = scimError(404, "Not found");
    const body = await res.json();
    expect(body.scimType).toBeUndefined();
  });

  it("returns 429 in SCIM error format", async () => {
    const res = scimError(429, "Too many requests");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    expect(body.status).toBe("429");
  });

  it("sets Content-Type to application/scim+json", () => {
    const res = scimError(400, "Bad request");
    expect(res.headers.get("content-type")).toBe("application/scim+json");
  });
});

describe("scimListResponse", () => {
  it("returns ListResponse schema", async () => {
    const res = scimListResponse([{ id: "1" }], 1);
    const body = await res.json();
    expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:ListResponse"]);
    expect(body.totalResults).toBe(1);
    expect(body.startIndex).toBe(1);
    expect(body.itemsPerPage).toBe(1);
    expect(body.Resources).toHaveLength(1);
  });

  it("respects custom startIndex", async () => {
    const res = scimListResponse([], 0, 5);
    const body = await res.json();
    expect(body.startIndex).toBe(5);
  });
});

describe("getScimBaseUrl", () => {
  const originalAppUrl = process.env.APP_URL;
  const originalNextAuthUrl = process.env.NEXTAUTH_URL;
  const originalAuthUrl = process.env.AUTH_URL;
  const originalBasePath = process.env.NEXT_PUBLIC_BASE_PATH;

  function clearEnv() {
    delete process.env.APP_URL;
    delete process.env.AUTH_URL;
    delete process.env.NEXTAUTH_URL;
    delete process.env.NEXT_PUBLIC_BASE_PATH;
  }

  afterEach(() => {
    clearEnv();
    if (originalAppUrl !== undefined) process.env.APP_URL = originalAppUrl;
    if (originalNextAuthUrl !== undefined) process.env.NEXTAUTH_URL = originalNextAuthUrl;
    if (originalAuthUrl !== undefined) process.env.AUTH_URL = originalAuthUrl;
    if (originalBasePath !== undefined) process.env.NEXT_PUBLIC_BASE_PATH = originalBasePath;
  });

  it("prefers APP_URL over AUTH_URL and NEXTAUTH_URL", () => {
    clearEnv();
    process.env.APP_URL = "https://app.example.com";
    process.env.AUTH_URL = "https://auth.example.com";
    process.env.NEXTAUTH_URL = "https://nextauth.example.com";
    expect(getScimBaseUrl()).toBe("https://app.example.com/api/scim/v2");
  });

  it("prefers AUTH_URL over NEXTAUTH_URL", () => {
    clearEnv();
    process.env.AUTH_URL = "https://auth.example.com";
    process.env.NEXTAUTH_URL = "https://nextauth.example.com";
    expect(getScimBaseUrl()).toBe("https://auth.example.com/api/scim/v2");
  });

  it("uses NEXTAUTH_URL as fallback", () => {
    clearEnv();
    process.env.NEXTAUTH_URL = "https://example.com";
    expect(getScimBaseUrl()).toBe("https://example.com/api/scim/v2");
  });

  it("falls back to localhost when no URL env is set", () => {
    clearEnv();
    expect(getScimBaseUrl()).toBe("http://localhost:3000/api/scim/v2");
  });

  it("strips trailing slash from origin", () => {
    clearEnv();
    process.env.AUTH_URL = "https://example.com/";
    expect(getScimBaseUrl()).toBe("https://example.com/api/scim/v2");
  });

  it("includes NEXT_PUBLIC_BASE_PATH in URL", () => {
    clearEnv();
    process.env.AUTH_URL = "https://example.com";
    process.env.NEXT_PUBLIC_BASE_PATH = "/passwd-sso";
    expect(getScimBaseUrl()).toBe("https://example.com/passwd-sso/api/scim/v2");
  });

  it("strips trailing slash from NEXT_PUBLIC_BASE_PATH", () => {
    clearEnv();
    process.env.AUTH_URL = "https://example.com";
    process.env.NEXT_PUBLIC_BASE_PATH = "/passwd-sso/";
    expect(getScimBaseUrl()).toBe("https://example.com/passwd-sso/api/scim/v2");
  });

  it("prepends leading slash when NEXT_PUBLIC_BASE_PATH lacks one", () => {
    clearEnv();
    process.env.AUTH_URL = "https://example.com";
    process.env.NEXT_PUBLIC_BASE_PATH = "passwd-sso";
    expect(getScimBaseUrl()).toBe("https://example.com/passwd-sso/api/scim/v2");
  });
});
