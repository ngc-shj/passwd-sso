import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRedirect, mockSetRequestLocale } = vi.hoisted(() => ({
  mockRedirect: vi.fn(),
  mockSetRequestLocale: vi.fn(),
}));

vi.mock("@/i18n/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next-intl/server", () => ({ setRequestLocale: mockSetRequestLocale }));

import SettingsRedirectPage from "./page";

function visit() {
  return SettingsRedirectPage({ params: Promise.resolve({ locale: "ja" }) });
}

describe("SettingsRedirectPage", () => {
  beforeEach(() => {
    mockRedirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
  });

  it("redirects to the profile sub-page in the route locale", async () => {
    await expect(visit()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith({
      href: "/dashboard/settings/account/profile",
      locale: "ja",
    });
  });

  it("sets the request locale before redirecting", async () => {
    await expect(visit()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockSetRequestLocale).toHaveBeenCalledWith("ja");
  });
});
