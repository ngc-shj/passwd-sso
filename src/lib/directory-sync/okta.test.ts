import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchOktaUsers, fetchOktaGroups } from "./okta";

const VALID_ORG = "https://dev-12345.okta.com/";

function jsonResponse(
  body: unknown,
  init: ResponseInit & { linkNext?: string } = {},
): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (init.linkNext) {
    headers.set("link", `<${init.linkNext}>; rel="next"`);
  }
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

describe("fetchOktaUsers", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("rejects an invalid org URL before any fetch call", async () => {
    await expect(fetchOktaUsers("https://example.com/", "tk")).rejects.toThrow(
      /Invalid Okta org URL/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns mapped users on a single page response", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse([
        {
          id: "u1",
          status: "ACTIVE",
          profile: {
            login: "alice",
            email: "a@x.com",
            firstName: "A",
            lastName: "L",
            displayName: "Alice",
          },
        },
      ]),
    );
    const users = await fetchOktaUsers(VALID_ORG, "tk");
    expect(users).toEqual([
      {
        id: "u1",
        status: "ACTIVE",
        profile: {
          login: "alice",
          email: "a@x.com",
          firstName: "A",
          lastName: "L",
          displayName: "Alice",
        },
      },
    ]);
  });

  it("follows the Link header rel=next across pages", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(
          [
            {
              id: "u1",
              status: "ACTIVE",
              profile: {
                login: "a",
                email: "a@x.com",
                firstName: "A",
                lastName: "L",
              },
            },
          ],
          { linkNext: `${VALID_ORG}api/v1/users?after=2` },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "u2",
            status: "ACTIVE",
            profile: {
              login: "b",
              email: "b@x.com",
              firstName: "B",
              lastName: "L",
            },
          },
        ]),
      );

    const users = await fetchOktaUsers(VALID_ORG, "tk");
    expect(users.map((u) => u.id)).toEqual(["u1", "u2"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects a Link rel=next URL whose origin differs from the initial URL (SSRF guard)", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([], { linkNext: "https://attacker.example.com/users" }),
    );

    await expect(fetchOktaUsers(VALID_ORG, "tk")).rejects.toThrow(
      /Pagination URL origin mismatch/,
    );
  });

  it("throws on a 401 response", async () => {
    fetchSpy.mockResolvedValue(new Response("denied", { status: 401 }));
    await expect(fetchOktaUsers(VALID_ORG, "tk")).rejects.toThrow(
      /Okta users request failed \(401\)/,
    );
  });

  it("throws on a 5xx response", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(fetchOktaUsers(VALID_ORG, "tk")).rejects.toThrow(
      /Okta users request failed \(500\)/,
    );
  });

  it("sends the SSWS Authorization header", async () => {
    fetchSpy.mockResolvedValue(jsonResponse([]));
    await fetchOktaUsers(VALID_ORG, "tk-secret");
    const init = fetchSpy.mock.calls[0][1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe("SSWS tk-secret");
  });
});

describe("fetchOktaGroups", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns mapped groups on a single page", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse([
        { id: "g1", profile: { name: "Engineers", description: "eng team" } },
        { id: "g2", profile: { name: "Ops" } },
      ]),
    );
    const groups = await fetchOktaGroups(VALID_ORG, "tk");
    expect(groups).toEqual([
      { id: "g1", profile: { name: "Engineers", description: "eng team" } },
      { id: "g2", profile: { name: "Ops", description: undefined } },
    ]);
  });

  it("throws on a 5xx response", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 502 }));
    await expect(fetchOktaGroups(VALID_ORG, "tk")).rejects.toThrow(
      /Okta groups request failed \(502\)/,
    );
  });

  it("rejects an invalid org URL before any fetch call", async () => {
    await expect(
      fetchOktaGroups("https://example.com/", "tk"),
    ).rejects.toThrow(/Invalid Okta org URL/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
