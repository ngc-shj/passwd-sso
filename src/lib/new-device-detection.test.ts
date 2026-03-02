import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockSessionFindMany,
  mockUserFindUnique,
  mockWithBypassRls,
  mockSendEmail,
  mockCreateNotification,
} = vi.hoisted(() => ({
  mockSessionFindMany: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockWithBypassRls: vi.fn(
    async (_prisma: unknown, fn: () => unknown) => fn(),
  ),
  mockSendEmail: vi.fn(),
  mockCreateNotification: vi.fn(),
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
    mockUserFindUnique.mockResolvedValue({ email: "user@example.com" });
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
    mockUserFindUnique.mockResolvedValue({ email: "user@example.com" });
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
