import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindActiveDelegationSession, mockFetchDelegationEntry } = vi.hoisted(() => ({
  mockFindActiveDelegationSession: vi.fn(),
  mockFetchDelegationEntry: vi.fn(),
}));

vi.mock("@/lib/delegation", () => ({
  findActiveDelegationSession: mockFindActiveDelegationSession,
  fetchDelegationEntry: mockFetchDelegationEntry,
}));

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: vi.fn((_prisma: unknown, fn: () => unknown) => fn()),
}));

import { toolGetDecryptedCredential } from "./tools";
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

describe("toolGetDecryptedCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error for service account tokens (no userId)", async () => {
    const token = makeToken({ userId: null, serviceAccountId: "sa-1" });
    const result = await toolGetDecryptedCredential(token, { id: "550e8400-e29b-41d4-a716-446655440000" });
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe(-32603);
  });

  it("returns error when no active delegation session exists", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce(null);
    const token = makeToken();
    const result = await toolGetDecryptedCredential(token, { id: "550e8400-e29b-41d4-a716-446655440000" });
    expect(result.error?.message).toContain("No active delegation session");
    expect(mockFindActiveDelegationSession).toHaveBeenCalledWith("user-1", "tok-1");
  });

  it("returns error when entry is not delegated (Redis miss)", async () => {
    mockFindActiveDelegationSession.mockResolvedValueOnce({ id: "session-1", expiresAt: new Date(Date.now() + 60000) });
    mockFetchDelegationEntry.mockResolvedValueOnce(null);
    const token = makeToken();
    const entryId = "550e8400-e29b-41d4-a716-446655440000";
    const result = await toolGetDecryptedCredential(token, { id: entryId });
    expect(result.error?.message).toContain("not delegated");
    expect(mockFetchDelegationEntry).toHaveBeenCalledWith("user-1", "session-1", entryId);
  });

  it("returns plaintext entry when delegation is active", async () => {
    const entryId = "550e8400-e29b-41d4-a716-446655440000";
    const mockEntry = { id: entryId, title: "GitHub", username: "alice", password: "secret", url: "https://github.com", notes: null };
    mockFindActiveDelegationSession.mockResolvedValueOnce({ id: "session-1", expiresAt: new Date(Date.now() + 60000) });
    mockFetchDelegationEntry.mockResolvedValueOnce(mockEntry);
    const token = makeToken();
    const result = await toolGetDecryptedCredential(token, { id: entryId });
    expect(result.result).toBeDefined();
    expect(result.result?.entry).toEqual(mockEntry);
    expect(mockFindActiveDelegationSession).toHaveBeenCalledWith("user-1", "tok-1");
    expect(mockFetchDelegationEntry).toHaveBeenCalledWith("user-1", "session-1", entryId);
  });

  it("returns error for invalid UUID input", async () => {
    const token = makeToken();
    const result = await toolGetDecryptedCredential(token, { id: "not-a-uuid" });
    expect(result.error?.code).toBe(-32602);
  });
});
