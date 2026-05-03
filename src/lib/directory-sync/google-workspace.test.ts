import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  getGoogleAccessToken,
  fetchGoogleUsers,
  fetchGoogleGroups,
  type GoogleServiceAccount,
} from "./google-workspace";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

// Generate an RSA keypair for the JWT signature once per test file.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const SA: GoogleServiceAccount = {
  client_email: "svc@project.iam.gserviceaccount.com",
  private_key: privateKey,
};

describe("getGoogleAccessToken", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("rejects an invalid domain before calling fetch", async () => {
    await expect(
      getGoogleAccessToken(SA, "not_a_domain", "admin@example.com"),
    ).rejects.toThrow(/Invalid Google Workspace domain/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the access_token on success", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ access_token: "tok" }));
    const tk = await getGoogleAccessToken(
      SA,
      "example.com",
      "admin@example.com",
    );
    expect(tk).toBe("tok");
  });

  it("posts to the Google OAuth2 token endpoint", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ access_token: "tok" }));
    await getGoogleAccessToken(SA, "example.com", "admin@example.com");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://oauth2.googleapis.com/token");
    expect((init as RequestInit | undefined)?.method).toBe("POST");
  });

  it("throws on a 401 response", async () => {
    fetchSpy.mockResolvedValue(
      new Response("denied", { status: 401 }),
    );
    await expect(
      getGoogleAccessToken(SA, "example.com", "admin@example.com"),
    ).rejects.toThrow(/Google token request failed \(401\)/);
  });

  it("throws on a 5xx response", async () => {
    fetchSpy.mockResolvedValue(
      new Response("server fail", { status: 503 }),
    );
    await expect(
      getGoogleAccessToken(SA, "example.com", "admin@example.com"),
    ).rejects.toThrow(/Google token request failed \(503\)/);
  });

  it("throws when access_token is missing in the response body", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ token_type: "Bearer" }));
    await expect(
      getGoogleAccessToken(SA, "example.com", "admin@example.com"),
    ).rejects.toThrow(/missing access_token/);
  });
});

describe("fetchGoogleUsers", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns mapped users on a single page", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        users: [
          {
            id: "u1",
            primaryEmail: "a@example.com",
            name: { fullName: "Alice" },
            suspended: false,
          },
        ],
      }),
    );
    const users = await fetchGoogleUsers("tk", "example.com");
    expect(users).toEqual([
      {
        id: "u1",
        primaryEmail: "a@example.com",
        name: { fullName: "Alice" },
        suspended: false,
      },
    ]);
  });

  it("follows nextPageToken across pages", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          users: [
            {
              id: "u1",
              primaryEmail: "a@x.com",
              name: { fullName: "A" },
              suspended: false,
            },
          ],
          nextPageToken: "page2",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          users: [
            {
              id: "u2",
              primaryEmail: "b@x.com",
              name: { fullName: "B" },
              suspended: true,
            },
          ],
        }),
      );

    const users = await fetchGoogleUsers("tk", "example.com");
    expect(users.map((u) => u.id)).toEqual(["u1", "u2"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("ignores oversized nextPageToken (>2048 chars) to stop pagination", async () => {
    const huge = "x".repeat(2049);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ users: [], nextPageToken: huge }),
    );
    const users = await fetchGoogleUsers("tk", "example.com");
    expect(users).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws on a 401 response", async () => {
    fetchSpy.mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(fetchGoogleUsers("tk", "example.com")).rejects.toThrow(
      /Google users request failed \(401\)/,
    );
  });

  it("throws on a 5xx response", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(fetchGoogleUsers("tk", "example.com")).rejects.toThrow(
      /Google users request failed \(500\)/,
    );
  });

  it("rejects an invalid domain before calling fetch", async () => {
    await expect(
      fetchGoogleUsers("tk", "bad domain"),
    ).rejects.toThrow(/Invalid Google Workspace domain/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("fetchGoogleGroups", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns mapped groups on a single page", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        groups: [
          { id: "g1", name: "Eng", email: "eng@example.com" },
          { id: "g2", name: "Ops", email: "ops@example.com" },
        ],
      }),
    );
    const groups = await fetchGoogleGroups("tk", "example.com");
    expect(groups).toEqual([
      { id: "g1", name: "Eng", email: "eng@example.com" },
      { id: "g2", name: "Ops", email: "ops@example.com" },
    ]);
  });

  it("throws on a 5xx response", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 503 }));
    await expect(fetchGoogleGroups("tk", "example.com")).rejects.toThrow(
      /Google groups request failed \(503\)/,
    );
  });
});
