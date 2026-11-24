import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockFindUnique,
  mockExecuteRaw,
  mockIsShareCreatorAdmitted,
  mockRateCheck,
  mockDecryptShareData,
  mockAccessLogCreate,
  mockLogFailure,
  headerState,
} = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockIsShareCreatorAdmitted: vi.fn(),
  mockRateCheck: vi.fn(),
  mockDecryptShareData: vi.fn(),
  mockAccessLogCreate: vi.fn(),
  mockLogFailure: vi.fn(),
  headerState: { ip: null as string | null, userAgent: null as string | null },
}));

vi.mock("next/headers", () => ({
  headers: async () => {
    const h = new Headers();
    if (headerState.userAgent !== null) h.set("user-agent", headerState.userAgent);
    return h;
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { passwordShare: { findUnique: mockFindUnique }, $executeRaw: mockExecuteRaw },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: async (_p: unknown, fn: (tx: unknown) => unknown) =>
    fn({ passwordShare: { findUnique: mockFindUnique }, shareAccessLog: { create: mockAccessLogCreate } }),
}));
vi.mock("@/lib/tenant-rls-grants", () => ({ BYPASS_GRANT: {} }));
vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: (t: string) => `hashed_${t}`,
  decryptShareData: mockDecryptShareData,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIpFromHeaders: () => headerState.ip,
  rateLimitKeyFromIp: (ip: string) => `key:${ip}`,
}));
vi.mock("@/lib/share/share-admission", () => ({
  isShareCreatorAdmitted: mockIsShareCreatorAdmitted,
}));
vi.mock("@/lib/logger/throttled", () => ({
  createThrottledErrorLogger: () => mockLogFailure,
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
import { ShareEntryView } from "@/components/share/share-entry-view";
import { ShareE2EEntryView } from "@/components/share/share-e2e-entry-view";
import { ShareSendView } from "@/components/share/share-send-view";
import { USER_AGENT_MAX_LENGTH, SHARE_ACCESS_IP_MAX_LENGTH } from "@/lib/validations/common.server";

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

async function render(token = TOKEN) {
  const el = (await SharePage({ params: Promise.resolve({ token }) })) as {
    type: unknown;
    props: Record<string, unknown>;
  };
  return el;
}

describe("/s/[token] page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    headerState.ip = null;
    headerState.userAgent = null;
    mockRateCheck.mockResolvedValue({ allowed: true });
    mockIsShareCreatorAdmitted.mockResolvedValue(true);
    mockExecuteRaw.mockResolvedValue(1);
    mockAccessLogCreate.mockResolvedValue({});
    mockDecryptShareData.mockReturnValue(JSON.stringify({ title: "T", password: "p" }));
  });

  describe("expired share", () => {
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

  it("answers rate-limited before touching the database, keyed by the client IP", async () => {
    headerState.ip = "203.0.113.9";
    mockRateCheck.mockResolvedValue({ allowed: false });

    const el = await render();

    expect(el.type).toBe(ShareError);
    expect(el.props.reason).toBe("rateLimited");
    expect(mockRateCheck).toHaveBeenCalledWith("rl:share_page:key:203.0.113.9");
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("keys the rate limit as unknown when no client IP is found", async () => {
    mockFindUnique.mockResolvedValue(makeShare());

    await render();

    expect(mockRateCheck).toHaveBeenCalledWith("rl:share_page:unknown");
  });

  it("answers not-found for a token that is not 64 lowercase hex chars", async () => {
    const el = await render("A".repeat(64));

    expect(el.type).toBe(ShareError);
    expect(el.props.reason).toBe("notFound");
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("looks the share up by the token hash", async () => {
    mockFindUnique.mockResolvedValue(null);

    const el = await render();

    expect(el.props.reason).toBe("notFound");
    expect(mockFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tokenHash: `hashed_${TOKEN}` } }));
  });

  it("answers revoked for a revoked share", async () => {
    mockFindUnique.mockResolvedValue(makeShare({ revokedAt: new Date() }));

    const el = await render();

    expect(el.props.reason).toBe("revoked");
    expect(mockIsShareCreatorAdmitted).not.toHaveBeenCalled();
  });

  it("answers revoked when the share's creator is no longer admitted", async () => {
    mockIsShareCreatorAdmitted.mockResolvedValue(false);
    mockFindUnique.mockResolvedValue(makeShare());

    const el = await render();

    expect(el.type).toBe(ShareError);
    expect(el.props.reason).toBe("revoked");
    expect(mockIsShareCreatorAdmitted).toHaveBeenCalledWith(expect.anything(), "share-1");
  });

  it("answers max-views for a protected share already at its limit", async () => {
    mockFindUnique.mockResolvedValue(makeShare({ maxViews: 3, viewCount: 3 }));

    const el = await render();

    expect(el.props.reason).toBe("maxViews");
  });

  it("passes the share id and token to the password gate without counting a view", async () => {
    mockFindUnique.mockResolvedValue(makeShare({ maxViews: 3, viewCount: 2 }));

    const el = await render();

    expect(el.type).toBe(ShareProtectedContent);
    expect(el.props).toEqual({ shareId: "share-1", token: TOKEN });
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  describe("unprotected share", () => {
    it("answers max-views when the atomic view increment matches no row", async () => {
      mockFindUnique.mockResolvedValue(makeShare({ accessPasswordHash: null }));
      mockExecuteRaw.mockResolvedValue(0);

      const el = await render();

      expect(el.props.reason).toBe("maxViews");
      expect(mockAccessLogCreate).not.toHaveBeenCalled();
    });

    it("answers max-views when a FILE share's recheck matches no row", async () => {
      mockFindUnique.mockResolvedValue(makeShare({ accessPasswordHash: null, shareType: "FILE" }));
      mockExecuteRaw.mockResolvedValue(0);

      const el = await render();

      expect(el.props.reason).toBe("maxViews");
    });

    it("increments view_count for an entry share but not for a FILE share", async () => {
      mockFindUnique.mockResolvedValue(makeShare({ accessPasswordHash: null }));
      await render();
      const entrySql = (mockExecuteRaw.mock.calls[0][0] as TemplateStringsArray).join("?");

      mockExecuteRaw.mockClear();
      mockFindUnique.mockResolvedValue(makeShare({ accessPasswordHash: null, shareType: "FILE" }));
      await render();
      const fileSql = (mockExecuteRaw.mock.calls[0][0] as TemplateStringsArray).join("?");

      expect(entrySql).toContain('"view_count" = "view_count" + 1');
      expect(fileSql).not.toContain("+ 1");
      expect(fileSql).toContain('"view_count" = "view_count"');
    });

    it("records the access with the IP and user agent truncated", async () => {
      headerState.ip = "1".repeat(SHARE_ACCESS_IP_MAX_LENGTH + 10);
      headerState.userAgent = "u".repeat(USER_AGENT_MAX_LENGTH + 10);
      mockFindUnique.mockResolvedValue(makeShare({ accessPasswordHash: null }));

      await render();

      expect(mockAccessLogCreate).toHaveBeenCalledWith({
        data: {
          shareId: "share-1",
          tenantId: "tenant-1",
          ip: "1".repeat(SHARE_ACCESS_IP_MAX_LENGTH),
          userAgent: "u".repeat(USER_AGENT_MAX_LENGTH),
        },
      });
    });

    it("records a null IP and user agent when neither is known", async () => {
      mockFindUnique.mockResolvedValue(makeShare({ accessPasswordHash: null }));

      await render();

      expect(mockAccessLogCreate).toHaveBeenCalledWith({
        data: { shareId: "share-1", tenantId: "tenant-1", ip: null, userAgent: null },
      });
    });

    it("still renders the share when the access log write fails, logging its code", async () => {
      mockFindUnique.mockResolvedValue(makeShare({ accessPasswordHash: null }));
      mockAccessLogCreate.mockRejectedValue({ code: "P2003" });

      const el = await render();

      expect(el.type).toBe(ShareEntryView);
      expect(mockLogFailure).toHaveBeenCalledWith("P2003");
    });

    it("hands an E2E share's ciphertext to the client-side view without decrypting", async () => {
      const expiresAt = new Date(Date.now() + 60_000);
      mockFindUnique.mockResolvedValue(
        makeShare({ accessPasswordHash: null, masterKeyVersion: 0, viewCount: 4, maxViews: 10, expiresAt }),
      );

      const el = await render();

      expect(el.type).toBe(ShareE2EEntryView);
      expect(el.props).toEqual({
        encryptedData: "enc",
        dataIv: "iv",
        dataAuthTag: "tag",
        entryType: "LOGIN",
        expiresAt: expiresAt.toISOString(),
        viewCount: 5,
        maxViews: 10,
      });
      expect(mockDecryptShareData).not.toHaveBeenCalled();
    });

    it("answers not-found when the server-side decrypt fails", async () => {
      mockFindUnique.mockResolvedValue(makeShare({ accessPasswordHash: null }));
      mockDecryptShareData.mockImplementation(() => {
        throw new Error("bad tag");
      });

      const el = await render();

      expect(el.type).toBe(ShareError);
      expect(el.props.reason).toBe("notFound");
    });

    it("decrypts with the share's key version and tenant", async () => {
      mockFindUnique.mockResolvedValue(makeShare({ accessPasswordHash: null, masterKeyVersion: 2 }));

      await render();

      expect(mockDecryptShareData).toHaveBeenCalledWith(
        { ciphertext: "enc", iv: "iv", authTag: "tag" },
        2,
        "tenant-1",
      );
    });

    it("renders a text send with the decrypted name and text and the incremented count", async () => {
      mockFindUnique.mockResolvedValue(
        makeShare({ accessPasswordHash: null, shareType: "TEXT", entryType: null, viewCount: 1 }),
      );
      mockDecryptShareData.mockReturnValue(JSON.stringify({ name: "Wifi", text: "hunter2" }));

      const el = await render();

      expect(el.type).toBe(ShareSendView);
      expect(el.props).toMatchObject({ sendType: "TEXT", name: "Wifi", text: "hunter2", token: TOKEN, viewCount: 2 });
    });

    it("falls back to the stored send name and empty text for a text send", async () => {
      mockFindUnique.mockResolvedValue(
        makeShare({ accessPasswordHash: null, shareType: "TEXT", entryType: null, sendName: "Stored" }),
      );
      mockDecryptShareData.mockReturnValue(JSON.stringify({}));

      const el = await render();

      expect(el.props).toMatchObject({ name: "Stored", text: "" });
    });

    it("renders a file send without counting the page view", async () => {
      mockFindUnique.mockResolvedValue(
        makeShare({
          accessPasswordHash: null,
          shareType: "FILE",
          entryType: null,
          sendFilename: "a.pdf",
          sendSizeBytes: 10,
          viewCount: 1,
        }),
      );
      mockDecryptShareData.mockReturnValue(JSON.stringify({}));

      const el = await render();

      expect(el.type).toBe(ShareSendView);
      expect(el.props).toMatchObject({ sendType: "FILE", name: "", filename: "a.pdf", sizeBytes: 10, viewCount: 1 });
    });

    it("renders an entry share with the decrypted data", async () => {
      mockFindUnique.mockResolvedValue(makeShare({ accessPasswordHash: null, viewCount: 0, maxViews: 2 }));

      const el = await render();

      expect(el.type).toBe(ShareEntryView);
      expect(el.props).toMatchObject({
        data: { title: "T", password: "p" },
        entryType: "LOGIN",
        viewCount: 1,
        maxViews: 2,
      });
    });
  });
});
