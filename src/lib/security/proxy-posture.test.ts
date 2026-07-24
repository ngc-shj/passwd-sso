import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWarn = vi.fn();
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: mockWarn, error: vi.fn(), info: vi.fn() }),
}));

import { warnOnProxyPosture } from "./proxy-posture";

describe("warnOnProxyPosture", () => {
  beforeEach(() => {
    mockWarn.mockReset();
  });

  it("warns in production when neither TRUST_PROXY_HEADERS nor TRUSTED_PROXIES is set", () => {
    const warned = warnOnProxyPosture({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(warned).toBe(true);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][1]).toContain("proxy_posture_client_ip_may_be_unavailable");
  });

  it("does not warn when TRUST_PROXY_HEADERS=true", () => {
    const warned = warnOnProxyPosture({
      NODE_ENV: "production",
      TRUST_PROXY_HEADERS: "true",
    } as NodeJS.ProcessEnv);
    expect(warned).toBe(false);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("does not warn when TRUSTED_PROXIES is configured", () => {
    const warned = warnOnProxyPosture({
      NODE_ENV: "production",
      TRUSTED_PROXIES: "10.0.0.0/8",
    } as NodeJS.ProcessEnv);
    expect(warned).toBe(false);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only TRUSTED_PROXIES as unset (still warns)", () => {
    const warned = warnOnProxyPosture({
      NODE_ENV: "production",
      TRUSTED_PROXIES: "   ",
    } as NodeJS.ProcessEnv);
    expect(warned).toBe(true);
  });

  it("never warns outside production", () => {
    expect(warnOnProxyPosture({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(false);
    expect(warnOnProxyPosture({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(false);
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
