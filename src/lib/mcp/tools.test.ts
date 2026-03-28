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

import { toolGetCredential, toolListCredentials, toolSearchCredentials } from "./tools";
import type { McpTokenData } from "@/lib/mcp/oauth-server";

const makeToken = (overrides?: Partial<McpTokenData>): McpTokenData => ({
  tokenId: "tok-1",
  tenantId: "t-1",
  clientId: "c-1",
  userId: "user-1",
  serviceAccountId: null,
  scopes: ["credentials:decrypt"],
  ...overrides,
});

const SESSION = { id: "session-1", expiresAt: new Date(Date.now() + 60000) };
const ENTRY_ID_1 = "550e8400-e29b-41d4-a716-446655440000";
const ENTRY_ID_2 = "660e8400-e29b-41d4-a716-446655440001";

const ENTRY_1 = { id: ENTRY_ID_1, title: "GitHub", username: "alice", password: "secret1", url: "https://github.com", notes: null };
const ENTRY_2 = { id: ENTRY_ID_2, title: "AWS Console", username: "bob", password: "secret2", url: "https://aws.amazon.com", notes: null };

// ─── toolGetCredential ───────────────────────────────────────

describe("toolGetCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error for service account tokens (no userId)", async () => {
    const token = makeToken({ userId: null, serviceAccountId: "sa-1" });
    const result = await toolGetCredential(token, { id: ENTRY_ID_1 });
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe(-32603);
  });

  it("returns error when no active delegation session exists", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(null);
    const token = makeToken();
    const result = await toolGetCredential(token, { id: ENTRY_ID_1 });
    expect(result.error?.message).toContain("No active delegation session");
    expect(mockFindActiveDelegationSession).toHaveBeenCalledWith("user-1", "tok-1");
  });

  it("returns error when entry is not delegated (Redis miss)", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(SESSION);
    mockFetchDelegationEntry.mockResolvedValueOnce(null);
    const token = makeToken();
    const result = await toolGetCredential(token, { id: ENTRY_ID_1 });
    expect(result.error?.message).toContain("not delegated");
    expect(mockFetchDelegationEntry).toHaveBeenCalledWith("user-1", "session-1", ENTRY_ID_1);
  });

  it("returns plaintext entry and logs audit when delegation is active", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(SESSION);
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_1);
    const token = makeToken();
    const result = await toolGetCredential(token, { id: ENTRY_ID_1 });
    expect(result.result).toBeDefined();
    expect(result.result?.entry).toEqual(ENTRY_1);
    expect(mockFindActiveDelegationSession).toHaveBeenCalledWith("user-1", "tok-1");
    expect(mockFetchDelegationEntry).toHaveBeenCalledWith("user-1", "session-1", ENTRY_ID_1);
    // Verify audit log — both personal and tenant scope
    expect(mockLogAudit).toHaveBeenCalledTimes(2);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      scope: "PERSONAL",
      action: "DELEGATION_READ",
      actorType: "MCP_AGENT",
      userId: "user-1",
      tenantId: "t-1",
      targetType: "PasswordEntry",
      targetId: ENTRY_ID_1,
      metadata: expect.objectContaining({ tool: "get", delegationSessionId: "session-1", mcpClientId: "c-1" }),
    }));
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      scope: "TENANT",
      action: "DELEGATION_READ",
    }));
  });

  it("returns error for invalid UUID input", async () => {
    const token = makeToken();
    const result = await toolGetCredential(token, { id: "not-a-uuid" });
    expect(result.error?.code).toBe(-32602);
  });

  it("passes ip to audit log", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(SESSION);
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_1);
    const token = makeToken();
    await toolGetCredential(token, { id: ENTRY_ID_1 }, "203.0.113.42");
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ ip: "203.0.113.42" }));
  });

  it("omits ip from audit log when null", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(SESSION);
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_1);
    const token = makeToken();
    await toolGetCredential(token, { id: ENTRY_ID_1 }, null);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ ip: undefined }));
  });
});

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
    mockGetDelegatedEntryIdsForSession.mockResolvedValueOnce(new Set([ENTRY_ID_1, ENTRY_ID_2]));
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_1);
    mockFetchDelegationEntry.mockResolvedValueOnce(ENTRY_2);

    const result = await toolListCredentials(makeToken(), {});
    expect(result.result).toBeDefined();
    expect(result.result?.entries).toHaveLength(2);
    expect(result.result?.total).toBe(2);
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
