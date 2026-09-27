import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindFirst, mockWithBypassRls } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockWithBypassRls: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { mcpClient: { findFirst: mockFindFirst } },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));

import { consentFormActionSources, MCP_CONSENT_PATH } from "./consent-form-action";

const params = (q: Record<string, string>) => new URLSearchParams(q);

beforeEach(() => {
  vi.clearAllMocks();
  mockWithBypassRls.mockImplementation(
    (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma),
  );
});

describe("consentFormActionSources", () => {
  it("admits the registered callback origin of a hosted client", async () => {
    mockFindFirst.mockResolvedValue({
      redirectUris: ["https://client.example/oauth/cb"],
    });

    await expect(
      consentFormActionSources(MCP_CONSENT_PATH, params({ client_id: "mcpc_x" })),
    ).resolves.toEqual(["https://client.example"]);
  });

  // The whole point of scoping this per response: the widening must not follow
  // the user onto any other page.
  it("adds nothing on any other path", async () => {
    mockFindFirst.mockResolvedValue({ redirectUris: ["https://client.example/cb"] });

    await expect(
      consentFormActionSources("/dashboard", params({ client_id: "mcpc_x" })),
    ).resolves.toEqual([]);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  // The attack this design exists to refuse. Reading `redirect_uri` from the
  // URL would let anyone name the origin their own page's policy admits.
  it("ignores a redirect_uri supplied in the query string", async () => {
    mockFindFirst.mockResolvedValue({ redirectUris: ["https://client.example/cb"] });

    const out = await consentFormActionSources(
      MCP_CONSENT_PATH,
      params({ client_id: "mcpc_x", redirect_uri: "https://evil.example/cb" }),
    );

    expect(out).toEqual(["https://client.example"]);
    expect(out).not.toContain("https://evil.example");
  });

  it("adds nothing for an unknown or inactive client", async () => {
    mockFindFirst.mockResolvedValue(null);

    await expect(
      consentFormActionSources(MCP_CONSENT_PATH, params({ client_id: "mcpc_x" })),
    ).resolves.toEqual([]);
  });

  it("adds nothing when client_id is absent or over-long", async () => {
    await expect(
      consentFormActionSources(MCP_CONSENT_PATH, params({})),
    ).resolves.toEqual([]);
    await expect(
      consentFormActionSources(MCP_CONSENT_PATH, params({ client_id: "x".repeat(300) })),
    ).resolves.toEqual([]);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  // A row written before the accept set was narrowed must not widen the policy
  // either — the same predicate authorize and consent re-check with.
  it("skips a stored URI the current accept set refuses", async () => {
    mockFindFirst.mockResolvedValue({
      redirectUris: ["http://[::1]:9000/cb", "http://evil.example/cb"],
    });

    await expect(
      consentFormActionSources(MCP_CONSENT_PATH, params({ client_id: "mcpc_x" })),
    ).resolves.toEqual([]);
  });

  // Loopback already has a port wildcard in the base policy; repeating a
  // specific loopback origin would only make the header longer.
  it("does not repeat loopback origins the base policy already covers", async () => {
    mockFindFirst.mockResolvedValue({
      redirectUris: ["http://127.0.0.1:8765/cb", "http://localhost:3000/cb"],
    });

    await expect(
      consentFormActionSources(MCP_CONSENT_PATH, params({ client_id: "mcpc_x" })),
    ).resolves.toEqual([]);
  });

  it("de-duplicates several callbacks sharing one origin", async () => {
    mockFindFirst.mockResolvedValue({
      redirectUris: ["https://client.example/a", "https://client.example/b"],
    });

    await expect(
      consentFormActionSources(MCP_CONSENT_PATH, params({ client_id: "mcpc_x" })),
    ).resolves.toEqual(["https://client.example"]);
  });

  // Fail to an unwidened policy, never to a 500 on the consent screen.
  it("adds nothing when the lookup throws", async () => {
    mockWithBypassRls.mockRejectedValue(new Error("db down"));

    await expect(
      consentFormActionSources(MCP_CONSENT_PATH, params({ client_id: "mcpc_x" })),
    ).resolves.toEqual([]);
  });
});
