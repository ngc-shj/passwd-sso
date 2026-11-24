import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRedirect } = vi.hoisted(() => ({ mockRedirect: vi.fn() }));

vi.mock("@/i18n/navigation", () => ({ redirect: mockRedirect }));

import Home from "./page";

describe("Home", () => {
  beforeEach(() => {
    mockRedirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
  });

  it("redirects to the dashboard in the route locale", async () => {
    await expect(Home({ params: Promise.resolve({ locale: "en" }) })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(mockRedirect).toHaveBeenCalledWith({ href: "/dashboard", locale: "en" });
  });
});
