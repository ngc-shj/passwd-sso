import { describe, it, expect, vi, beforeEach } from "vitest";

import { ensureHostPermission } from "../lib/api";

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

  it("requests permission when not already granted", async () => {
    const chromeMock = installChromeMock();
    chromeMock.permissions.contains.mockResolvedValue(false);
    const ok = await ensureHostPermission("https://example.com");
    expect(ok).toBe(true);
    expect(chromeMock.permissions.request).toHaveBeenCalledWith({
      origins: ["https://example.com/*"],
    });
  });

  it("returns false when permission request is denied", async () => {
    const chromeMock = installChromeMock();
    chromeMock.permissions.contains.mockResolvedValue(false);
    chromeMock.permissions.request.mockResolvedValue(false);
    const ok = await ensureHostPermission("https://example.com");
    expect(ok).toBe(false);
  });
});
