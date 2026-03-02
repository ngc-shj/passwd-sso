import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockSessionFindMany,
  mockUserFindUnique,
  mockWithBypassRls,
  mockSendEmail,
  mockCreateNotification,
  mockResolveUserLocale,
} = vi.hoisted(() => ({
  mockSessionFindMany: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockWithBypassRls: vi.fn(
    async (_prisma: unknown, fn: () => unknown) => fn(),
  ),
  mockSendEmail: vi.fn(),
  mockCreateNotification: vi.fn(),
  mockResolveUserLocale: vi.fn(
    (stored?: string | null, accept?: string | null) => {
      if (stored) return stored;
      if (accept) {
        const lower = accept.toLowerCase();
        const enIdx = lower.search(/\ben/);
        const jaIdx = lower.search(/\bja/);
        if (enIdx >= 0 && (jaIdx < 0 || enIdx < jaIdx)) return "en";
        return "ja";
      }
      return "ja";
    },
  ),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    session: { findMany: mockSessionFindMany },
    user: { findUnique: mockUserFindUnique },
  },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/email", () => ({
  sendEmail: mockSendEmail,
}));
vi.mock("@/lib/notification", () => ({
  createNotification: mockCreateNotification,
}));
vi.mock("@/lib/locale", () => ({
  resolveUserLocale: mockResolveUserLocale,
}));

import { checkNewDeviceAndNotify } from "./new-device-detection";

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0";
const FIREFOX_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15) Gecko/20100101 Firefox/121.0";

describe("checkNewDeviceAndNotify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips when userAgent is null", async () => {
    await checkNewDeviceAndNotify("user-1", { ip: "1.2.3.4", userAgent: null, acceptLanguage: null });
    expect(mockSessionFindMany).not.toHaveBeenCalled();
  });

  it("skips notification for first login (no previous sessions)", async () => {
    mockSessionFindMany.mockResolvedValue([]);

    await checkNewDeviceAndNotify("user-1", {
      ip: "1.2.3.4",
      userAgent: CHROME_WIN,
      acceptLanguage: null,
    });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("does not notify when same device (browser + OS match)", async () => {
    mockSessionFindMany.mockResolvedValue([
      { userAgent: CHROME_WIN },
    ]);

    await checkNewDeviceAndNotify("user-1", {
      ip: "1.2.3.4",
      userAgent: CHROME_WIN,
      acceptLanguage: null,
    });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("sends email and notification for new device", async () => {
    mockSessionFindMany.mockResolvedValue([
      { userAgent: CHROME_WIN },
    ]);
    mockUserFindUnique.mockResolvedValue({ email: "user@example.com", locale: null });
    mockCreateNotification.mockResolvedValue(undefined);

    await checkNewDeviceAndNotify("user-1", {
      ip: "5.6.7.8",
      userAgent: FIREFOX_MAC,
      acceptLanguage: null,
    });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.com",
        subject: expect.stringContaining("ログイン"),
      }),
    );

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        type: "NEW_DEVICE_LOGIN",
      }),
    );
  });

  it("uses Japanese locale when Accept-Language starts with ja", async () => {
    mockSessionFindMany.mockResolvedValue([
      { userAgent: CHROME_WIN },
    ]);
    mockUserFindUnique.mockResolvedValue({ email: "user@example.com", locale: null });
    mockCreateNotification.mockResolvedValue(undefined);

    await checkNewDeviceAndNotify("user-1", {
      ip: "5.6.7.8",
      userAgent: FIREFOX_MAC,
      acceptLanguage: "ja,en-US;q=0.9",
    });

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "新しいデバイスからのログイン",
      }),
    );
  });

  it("uses stored user locale over Accept-Language", async () => {
    mockSessionFindMany.mockResolvedValue([
      { userAgent: CHROME_WIN },
    ]);
    mockUserFindUnique.mockResolvedValue({ email: "user@example.com", locale: "en" });
    mockCreateNotification.mockResolvedValue(undefined);

    await checkNewDeviceAndNotify("user-1", {
      ip: "5.6.7.8",
      userAgent: FIREFOX_MAC,
      acceptLanguage: "ja,en-US;q=0.9",
    });

    expect(mockResolveUserLocale).toHaveBeenCalledWith("en", "ja,en-US;q=0.9");
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("New device login"),
      }),
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "New device login",
      }),
    );
  });

  it("excludes current session token from past session query", async () => {
    mockSessionFindMany.mockResolvedValue([{ userAgent: CHROME_WIN }]);

    await checkNewDeviceAndNotify("user-1", {
      ip: "1.2.3.4",
      userAgent: CHROME_WIN,
      acceptLanguage: null,
      currentSessionToken: "current-token-abc",
    });

    expect(mockSessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sessionToken: { not: "current-token-abc" },
        }),
      }),
    );
  });

  it("skips notification when user is not found", async () => {
    mockSessionFindMany.mockResolvedValue([{ userAgent: CHROME_WIN }]);
    mockUserFindUnique.mockResolvedValue(null);

    await checkNewDeviceAndNotify("user-1", {
      ip: "5.6.7.8",
      userAgent: FIREFOX_MAC,
      acceptLanguage: null,
    });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("never throws even on error", async () => {
    mockSessionFindMany.mockRejectedValue(new Error("DB down"));

    // Should not throw
    await expect(
      checkNewDeviceAndNotify("user-1", {
        ip: "1.2.3.4",
        userAgent: CHROME_WIN,
        acceptLanguage: null,
      }),
    ).resolves.toBeUndefined();
  });
});
