import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getAzureAdToken,
  fetchAzureAdUsers,
  fetchAzureAdGroups,
} from "./azure-ad";

const VALID_TENANT_ID = "11111111-2222-3333-4444-555555555555";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("getAzureAdToken", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("rejects an invalid (non-UUID) tenant ID before calling fetch", async () => {
    await expect(
      getAzureAdToken("not-a-uuid", "client", "secret"),
    ).rejects.toThrow(/Invalid Azure AD tenant ID/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the access_token on a successful response", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ access_token: "tk_abc" }));
    const tk = await getAzureAdToken(VALID_TENANT_ID, "cid", "sec");
    expect(tk).toBe("tk_abc");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain(VALID_TENANT_ID);
    expect(String(url)).toContain("/oauth2/v2.0/token");
  });

  it("throws when the token endpoint returns 401", async () => {
    fetchSpy.mockResolvedValue(
      new Response("unauthorized", { status: 401 }),
    );
    await expect(
      getAzureAdToken(VALID_TENANT_ID, "cid", "sec"),
    ).rejects.toThrow(/Azure AD token request failed \(401\)/);
  });

  it("throws when the token endpoint returns 5xx", async () => {
    fetchSpy.mockResolvedValue(
      new Response("server error", { status: 503 }),
    );
    await expect(
      getAzureAdToken(VALID_TENANT_ID, "cid", "sec"),
    ).rejects.toThrow(/Azure AD token request failed \(503\)/);
  });

  it("throws when the response is missing access_token", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ token_type: "Bearer" }));
    await expect(
      getAzureAdToken(VALID_TENANT_ID, "cid", "sec"),
    ).rejects.toThrow(/missing access_token/);
  });
});

describe("fetchAzureAdUsers", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns mapped users on a single page response", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        value: [
          {
            id: "u1",
            displayName: "Alice",
            mail: "a@example.com",
            accountEnabled: true,
          },
          {
            id: "u2",
            displayName: "Bob",
            mail: null,
            accountEnabled: false,
          },
        ],
      }),
    );
    const users = await fetchAzureAdUsers("token");
    expect(users).toEqual([
      {
        id: "u1",
        displayName: "Alice",
        mail: "a@example.com",
        accountEnabled: true,
      },
      { id: "u2", displayName: "Bob", mail: null, accountEnabled: false },
    ]);
  });

  it("follows @odata.nextLink across pages", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            { id: "u1", displayName: "A", mail: null, accountEnabled: true },
          ],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?next=2",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            { id: "u2", displayName: "B", mail: null, accountEnabled: true },
          ],
        }),
      );

    const users = await fetchAzureAdUsers("token");
    expect(users.map((u) => u.id)).toEqual(["u1", "u2"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects a pagination URL whose origin is not graph.microsoft.com (SSRF guard)", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        value: [],
        "@odata.nextLink": "https://attacker.example.com/users",
      }),
    );

    await expect(fetchAzureAdUsers("token")).rejects.toThrow(
      /Pagination URL origin mismatch/,
    );
  });

  it("throws on a 401 response", async () => {
    fetchSpy.mockResolvedValue(
      new Response("nope", { status: 401 }),
    );
    await expect(fetchAzureAdUsers("token")).rejects.toThrow(
      /Azure AD users request failed \(401\)/,
    );
  });

  it("throws on a 5xx response", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 502 }));
    await expect(fetchAzureAdUsers("token")).rejects.toThrow(
      /Azure AD users request failed \(502\)/,
    );
  });

  it("sends a Bearer Authorization header", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ value: [] }));
    await fetchAzureAdUsers("my-token");
    const init = fetchSpy.mock.calls[0][1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe("Bearer my-token");
  });
});

describe("fetchAzureAdGroups", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("fetches groups and their user-typed members, ignoring non-user member types", async () => {
    fetchSpy
      // groups list
      .mockResolvedValueOnce(
        jsonResponse({
          value: [{ id: "g1", displayName: "Engineers" }],
        }),
      )
      // members of g1
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            { "@odata.type": "#microsoft.graph.user", id: "u1" },
            { "@odata.type": "#microsoft.graph.group", id: "subgroup" },
            { "@odata.type": "#microsoft.graph.user", id: "u2" },
          ],
        }),
      );

    const groups = await fetchAzureAdGroups("token");
    expect(groups).toEqual([
      { id: "g1", displayName: "Engineers", members: ["u1", "u2"] },
    ]);
  });

  it("propagates a 5xx error from the groups list", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(fetchAzureAdGroups("token")).rejects.toThrow(
      /Azure AD groups request failed \(500\)/,
    );
  });
});
