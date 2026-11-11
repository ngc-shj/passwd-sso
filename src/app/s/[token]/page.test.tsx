import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindUnique, mockExecuteRaw, mockIsShareCreatorAdmitted } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockIsShareCreatorAdmitted: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { passwordShare: { findUnique: mockFindUnique }, $executeRaw: mockExecuteRaw },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: async (_p: unknown, fn: (tx: unknown) => unknown) =>
    fn({ passwordShare: { findUnique: mockFindUnique }, shareAccessLog: { create: vi.fn().mockResolvedValue({}) } }),
}));
vi.mock("@/lib/tenant-rls-grants", () => ({ BYPASS_GRANT: {} }));
vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: (t: string) => `hashed_${t}`,
  decryptShareData: vi.fn(),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: async () => ({ allowed: true }), clear: vi.fn() }),
}));
vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIpFromHeaders: () => null,
  rateLimitKeyFromIp: (ip: string) => ip,
}));
vi.mock("@/lib/share/share-admission", () => ({
  isShareCreatorAdmitted: mockIsShareCreatorAdmitted,
}));
vi.mock("@/lib/logger/throttled", () => ({
  createThrottledErrorLogger: () => vi.fn(),
  REDIS_FALLBACK_LOG_THROTTLE_MS: 0,
}));
vi.mock("@/components/share/share-entry-view", () => ({ ShareEntryView: () => null }));
vi.mock("@/components/share/share-e2e-entry-view", () => ({ ShareE2EEntryView: () => null }));
vi.mock("@/components/share/share-send-view", () => ({ ShareSendView: () => null }));
vi.mock("@/components/share/share-error", () => ({ ShareError: () => null }));
vi.mock("@/components/share/share-protected-content", () => ({ ShareProtectedContent: () => null }));

import SharePage from "./page";
import { ShareError } from "@/components/share/share-error";
import { ShareProtectedContent } from "@/components/share/share-protected-content";

const TOKEN = "a".repeat(64);

function makeShare(overrides: Record<string, unknown> = {}) {
  return {
    id: "share-1",
    tenantId: "tenant-1",
    shareType: "ENTRY_SHARE",
    entryType: "LOGIN",
    encryptedData: "enc",
    dataIv: "iv",
    dataAuthTag: "tag",
    sendName: null,
    sendFilename: null,
    sendSizeBytes: null,
    masterKeyVersion: 1,
    expiresAt: new Date(Date.now() + 3_600_000),
    maxViews: null,
    viewCount: 0,
    revokedAt: null,
    accessPasswordHash: "hash",
    ...overrides,
  };
}

async function render() {
  const el = (await SharePage({ params: Promise.resolve({ token: TOKEN }) })) as {
    type: unknown;
    props: Record<string, unknown>;
  };
  return el;
}

describe("/s/[token] page — expired share", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsShareCreatorAdmitted.mockResolvedValue(true);
  });

  it("renders the expired error, not the content, for an expired unrevoked share", async () => {
    mockFindUnique.mockResolvedValue(makeShare({ expiresAt: new Date(Date.now() - 1000) }));

    const el = await render();

    expect(el.type).toBe(ShareError);
    expect(el.props.reason).toBe("expired");
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it("renders the content gate for a share that has not expired (control)", async () => {
    mockFindUnique.mockResolvedValue(makeShare());

    const el = await render();

    expect(el.type).toBe(ShareProtectedContent);
  });
});
