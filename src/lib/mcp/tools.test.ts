import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindActiveDelegationSession, mockFetchDelegationEntry, mockGetDelegatedEntryIdsForSession } = vi.hoisted(() => ({
  mockFindActiveDelegationSession: vi.fn(),
  mockFetchDelegationEntry: vi.fn(),
  mockGetDelegatedEntryIdsForSession: vi.fn(),
}));

const { mockLogAudit } = vi.hoisted(() => ({
  mockLogAudit: vi.fn(),
}));

vi.mock("@/lib/auth/access/delegation", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  findActiveDelegationSession: mockFindActiveDelegationSession,
  fetchDelegationEntry: mockFetchDelegationEntry,
  getDelegatedEntryIdsForSession: mockGetDelegatedEntryIdsForSession,
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  // Mirror the production fan-out: emit both PERSONAL and TENANT events
  // so the test continues to assert dual emission (existing test counts
  // mockLogAudit invocations as 2 per call).
  logAuditAsyncBothScopes: vi.fn(async (base: Record<string, unknown>) => {
    await Promise.all([
      mockLogAudit({ ...base, scope: "PERSONAL" }),
      mockLogAudit({ ...base, scope: "TENANT" }),
    ]);
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: vi.fn((prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
}));

import { toolListCredentials, toolSearchCredentials, MCP_TOOLS } from "./tools";
import { USER_SUPPLIED_METADATA_WARNING } from "@/lib/auth/access/delegation";
import type { McpTokenData } from "@/lib/mcp/oauth-server";

const makeToken = (overrides?: Partial<McpTokenData>): McpTokenData => ({
  tokenId: "tok-1",
  tenantId: "t-1",
  clientId: "c-1",
  mcpClientId: "mcpc_test123",
  userId: "user-1",
  serviceAccountId: null,
  scopes: ["credentials:list"],
  ...overrides,
});

const SESSION = { id: "session-1", expiresAt: new Date(Date.now() + 60000) };
const ENTRY_ID_1 = "550e8400-e29b-41d4-a716-446655440000";
const ENTRY_ID_2 = "660e8400-e29b-41d4-a716-446655440001";

// Metadata-only fixtures — no password/notes/url
const ENTRY_1 = { id: ENTRY_ID_1, title: "GitHub", username: "alice", urlHost: "github.com", tags: null };
const ENTRY_2 = { id: ENTRY_ID_2, title: "AWS Console", username: "bob", urlHost: "aws.amazon.com", tags: null };

// ─── toolListCredentials ─────────────────────────────────────

describe("MCP_TOOLS descriptions (C4 I-C4-3)", () => {
  it("list_credentials description includes the user-supplied metadata warning", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "list_credentials");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain(USER_SUPPLIED_METADATA_WARNING);
    // Tags should not be advertised as a returned field anymore.
    expect(tool!.description).not.toMatch(/\btags\b/);
  });

  it("search_credentials description includes the user-supplied metadata warning", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "search_credentials");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain(USER_SUPPLIED_METADATA_WARNING);
  });
});

describe("toolListCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error for service account tokens", async () => {
    const token = makeToken({ userId: null, serviceAccountId: "sa-1" });
    const result = await toolListCredentials(token, {});
    expect(result.error?.code).toBe(-32603);
  });

  it("returns error when no active delegation session", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(null);
    const result = await toolListCredentials(makeToken(), {});
    expect(result.error?.message).toContain("No active delegation session");
  });

  it("returns all delegated entries with pagination metadata and agent-facing shape", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(SESSION);
    mockGetDelegatedEntryIdsForSession.mockResolvedValueOnce(new Set([ENTRY_ID_1]));
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_1);

    const result = await toolListCredentials(makeToken(), {});
    expect(result.result).toBeDefined();
    expect(result.result?.entries).toHaveLength(1);
    expect(result.result?.total).toBe(1);
    // Verify projector applied: agent-facing shape with provenance label,
    // no secret fields, no tags (C4 I-C4-1, I-C4-2).
    if ("result" in result && result.result) {
      const entry = result.result.entries[0] as unknown as Record<string, unknown>;
      expect(entry).not.toHaveProperty("password");
      expect(entry).not.toHaveProperty("notes");
      expect(entry).not.toHaveProperty("url");
      expect(entry).not.toHaveProperty("tags");
      expect(entry.metadataProvenance).toBe("user-supplied");
      expect(Object.keys(entry).sort()).toEqual(
        ["id", "metadataProvenance", "title", "urlHost", "username"].sort(),
      );
    }
  });

  it("applies limit and offset pagination", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(SESSION);
    mockGetDelegatedEntryIdsForSession.mockResolvedValueOnce(new Set([ENTRY_ID_1, ENTRY_ID_2]));
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_1);
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_2);

    const result = await toolListCredentials(makeToken(), { limit: 1, offset: 1 });
    expect(result.result?.entries).toHaveLength(1);
    expect(result.result?.total).toBe(2);
  });

  it("returns empty list when no entries delegated", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(SESSION);
    mockGetDelegatedEntryIdsForSession.mockResolvedValueOnce(new Set());

    const result = await toolListCredentials(makeToken(), {});
    expect(result.result?.entries).toHaveLength(0);
    expect(result.result?.total).toBe(0);
  });

  it("rejects invalid limit", async () => {
    const result = await toolListCredentials(makeToken(), { limit: 999 });
    expect(result.error?.code).toBe(-32602);
  });

  it("logs audit with entryCount", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(SESSION);
    mockGetDelegatedEntryIdsForSession.mockResolvedValueOnce(new Set([ENTRY_ID_1]));
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_1);

    await toolListCredentials(makeToken(), {}, "10.0.0.1");
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "DELEGATION_READ",
      ip: "10.0.0.1",
      metadata: expect.objectContaining({ tool: "list", entryCount: 1 }),
    }));
  });

});

// ─── toolSearchCredentials ───────────────────────────────────

describe("toolSearchCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error for service account tokens", async () => {
    const token = makeToken({ userId: null, serviceAccountId: "sa-1" });
    const result = await toolSearchCredentials(token, { query: "test" });
    expect(result.error?.code).toBe(-32603);
  });

  it("returns error when no active delegation session", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(null);
    const result = await toolSearchCredentials(makeToken(), { query: "git" });
    expect(result.error?.message).toContain("No active delegation session");
  });

  it("filters entries by query matching title", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(SESSION);
    mockGetDelegatedEntryIdsForSession.mockResolvedValueOnce(new Set([ENTRY_ID_1, ENTRY_ID_2]));
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_1);
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_2);

    const result = await toolSearchCredentials(makeToken(), { query: "GitHub" });
    expect(result.result?.entries).toHaveLength(1);
    expect(result.result?.entries[0].title).toBe("GitHub");
    expect(result.result?.total).toBe(1);
  });

  it("filters entries by query matching username (case-insensitive)", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(SESSION);
    mockGetDelegatedEntryIdsForSession.mockResolvedValueOnce(new Set([ENTRY_ID_1, ENTRY_ID_2]));
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_1);
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_2);

    const result = await toolSearchCredentials(makeToken(), { query: "BOB" });
    expect(result.result?.entries).toHaveLength(1);
    expect(result.result?.entries[0].username).toBe("bob");
    // Verify metadata-only in the returned entry
    if ("result" in result && result.result) {
      const entry = result.result.entries[0] as unknown as Record<string, unknown>;
      expect(entry).not.toHaveProperty("password");
      expect(entry).not.toHaveProperty("notes");
      expect(entry).not.toHaveProperty("url");
    }
  });

  it("returns all entries when query is omitted", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(SESSION);
    mockGetDelegatedEntryIdsForSession.mockResolvedValueOnce(new Set([ENTRY_ID_1, ENTRY_ID_2]));
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_1);
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_2);

    const result = await toolSearchCredentials(makeToken(), {});
    expect(result.result?.entries).toHaveLength(2);
    expect(result.result?.total).toBe(2);
  });

  it("trims whitespace-only query and treats as no query", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(SESSION);
    mockGetDelegatedEntryIdsForSession.mockResolvedValueOnce(new Set([ENTRY_ID_1]));
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_1);

    const result = await toolSearchCredentials(makeToken(), { query: "   " });
    expect(result.result?.entries).toHaveLength(1);
    expect(result.result?.total).toBe(1);
  });

  it("applies pagination to filtered results", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(SESSION);
    mockGetDelegatedEntryIdsForSession.mockResolvedValueOnce(new Set([ENTRY_ID_1, ENTRY_ID_2]));
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_1);
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_2);

    const result = await toolSearchCredentials(makeToken(), { limit: 1, offset: 0 });
    expect(result.result?.entries).toHaveLength(1);
    expect(result.result?.total).toBe(2);
  });

  it("logs audit with query and entryCount", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(SESSION);
    mockGetDelegatedEntryIdsForSession.mockResolvedValueOnce(new Set([ENTRY_ID_1]));
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_1);

    await toolSearchCredentials(makeToken(), { query: "git" }, "10.0.0.1");
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ tool: "search", query: "git", entryCount: 1 }),
      ip: "10.0.0.1",
    }));
  });
});
