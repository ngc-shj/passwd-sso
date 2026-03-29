import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindActiveDelegationSession, mockFetchDelegationEntry, mockGetDelegatedEntryIdsForSession } = vi.hoisted(() => ({
  mockFindActiveDelegationSession: vi.fn(),
  mockFetchDelegationEntry: vi.fn(),
  mockGetDelegatedEntryIdsForSession: vi.fn(),
}));

const { mockLogAudit } = vi.hoisted(() => ({
  mockLogAudit: vi.fn(),
}));

vi.mock("@/lib/delegation", () => ({
  findActiveDelegationSession: mockFindActiveDelegationSession,
  fetchDelegationEntry: mockFetchDelegationEntry,
  getDelegatedEntryIdsForSession: mockGetDelegatedEntryIdsForSession,
}));

vi.mock("@/lib/audit", () => ({ logAudit: mockLogAudit }));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: vi.fn((_prisma: unknown, fn: () => unknown) => fn()),
}));

import { toolListCredentials, toolSearchCredentials } from "./tools";
import type { McpTokenData } from "@/lib/mcp/oauth-server";

const makeToken = (overrides?: Partial<McpTokenData>): McpTokenData => ({
  tokenId: "tok-1",
  tenantId: "t-1",
  clientId: "c-1",
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

  it("returns all delegated entries with pagination metadata", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(SESSION);
    mockGetDelegatedEntryIdsForSession.mockResolvedValueOnce(new Set([ENTRY_ID_1]));
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_1);

    const result = await toolListCredentials(makeToken(), {});
    expect(result.result).toBeDefined();
    expect(result.result?.entries).toHaveLength(1);
    expect(result.result?.total).toBe(1);
    // Verify metadata-only: no secret fields in the returned entries
    if ("result" in result && result.result) {
      const entry = result.result.entries[0] as unknown as Record<string, unknown>;
      expect(entry).not.toHaveProperty("password");
      expect(entry).not.toHaveProperty("notes");
      expect(entry).not.toHaveProperty("url");
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

  it("accepts legacy credentials:decrypt scope", async () => {
    const token = makeToken({ scopes: ["credentials:decrypt"] });
    mockFindActiveDelegationSession.mockResolvedValueOnce(SESSION);
    mockGetDelegatedEntryIdsForSession.mockResolvedValueOnce(new Set([ENTRY_ID_1]));
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_1);

    const result = await toolListCredentials(token, {});
    expect(result.result).toBeDefined();
    expect(result.result?.entries).toHaveLength(1);
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
