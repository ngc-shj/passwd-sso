import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCookies } = vi.hoisted(() => ({ mockCookies: vi.fn() }));

// boundary: Next.js request-scoped API
vi.mock("next/headers", () => ({ cookies: mockCookies }));

import { getCspNonce } from "./csp-nonce.server";
import { CSP_NONCE_COOKIE } from "./csp-nonce-names";

function cookieStore(entries: Record<string, string>) {
  return {
    get: (name: string) =>
      name in entries ? { name, value: entries[name] } : undefined,
  };
}

describe("getCspNonce", () => {
  beforeEach(() => {
    mockCookies.mockReset();
  });

  it("returns the nonce the proxy wrote for this request", async () => {
    mockCookies.mockResolvedValue(
      cookieStore({ [CSP_NONCE_COOKIE]: "rAnd0mNonce==" }),
    );

    await expect(getCspNonce()).resolves.toBe("rAnd0mNonce==");
  });

  // A page reached outside the proxy's matcher gets no response CSP either,
  // so there is no nonce to honour — "" is the correct answer, not a throw.
  it("returns an empty string when the cookie is absent", async () => {
    mockCookies.mockResolvedValue(cookieStore({}));

    await expect(getCspNonce()).resolves.toBe("");
  });

  // Pins the cookie NAME, not just the read: the proxy writes it under
  // CSP_NONCE_COOKIE and a divergence here would silently blank every nonce.
  it("reads the same cookie name the proxy writes", async () => {
    const get = vi.fn().mockReturnValue({ value: "x" });
    mockCookies.mockResolvedValue({ get });

    await getCspNonce();

    expect(get).toHaveBeenCalledWith(CSP_NONCE_COOKIE);
  });
});
