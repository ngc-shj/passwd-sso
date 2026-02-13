import { describe, it, expect, vi, beforeEach } from "vitest";
import { EXT_API_PATH } from "../lib/api-paths";

const mockSendMessage = vi.fn();
const mockGetSettings = vi.fn();

vi.mock("../lib/messaging", () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
}));
vi.mock("../lib/storage", () => ({
  getSettings: () => mockGetSettings(),
}));

import { apiFetch, ensureHostPermission } from "../lib/api";

function installChromeMock() {
  const chromeMock = {
    permissions: {
      contains: vi.fn().mockResolvedValue(true),
      request: vi.fn().mockResolvedValue(true),
    },
  };
  vi.stubGlobal("chrome", chromeMock);
  return chromeMock;
}

describe("ensureHostPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses origin even when serverUrl has a path", async () => {
    const chromeMock = installChromeMock();
    const ok = await ensureHostPermission("https://example.com/app");
    expect(ok).toBe(true);
    expect(chromeMock.permissions.contains).toHaveBeenCalledWith({
      origins: ["https://example.com/*"],
    });
  });

  it("returns false on invalid serverUrl", async () => {
    installChromeMock();
    const ok = await ensureHostPermission("not-a-url");
    expect(ok).toBe(false);
  });
});

describe("apiFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installChromeMock();
    mockGetSettings.mockResolvedValue({ serverUrl: "https://example.com/app" });
  });

  it("returns null when no token", async () => {
    mockSendMessage.mockResolvedValue({ token: null });
    const res = await apiFetch(EXT_API_PATH.PASSWORDS);
    expect(res).toBeNull();
  });

  it("returns null when permission is denied", async () => {
    const chromeMock = installChromeMock();
    chromeMock.permissions.contains.mockResolvedValue(false);
    chromeMock.permissions.request.mockResolvedValue(false);
    mockSendMessage.mockResolvedValue({ token: "t" });
    const res = await apiFetch(EXT_API_PATH.PASSWORDS);
    expect(res).toBeNull();
  });

  it("fetches using origin + path with Bearer token", async () => {
    mockSendMessage.mockResolvedValue({ token: "t" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => ({
        ok: true,
        url,
        init,
      }))
    );

    const res = (await apiFetch(EXT_API_PATH.PASSWORDS)) as unknown as {
      url: string;
      init?: RequestInit;
    };
    expect(res.url).toBe("https://example.com/api/passwords");
    expect(res.init?.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer t" })
    );
  });
});
