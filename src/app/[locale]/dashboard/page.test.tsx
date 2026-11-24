import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

const { search } = vi.hoisted(() => ({ search: { current: new URLSearchParams() } }));

vi.mock("next/navigation", () => ({ useSearchParams: () => search.current }));
vi.mock("@/components/passwords/detail/password-dashboard", () => ({
  PasswordDashboard: () => null,
}));

import DashboardPage from "./page";
import { PasswordDashboard } from "@/components/passwords/detail/password-dashboard";

describe("DashboardPage", () => {
  it("filters the all-entries view by the type query parameter", () => {
    search.current = new URLSearchParams("type=SECURE_NOTE");
    const el = DashboardPage() as ReactElement;
    expect(el.type).toBe(PasswordDashboard);
    expect(el.props).toEqual({ view: "all", entryType: "SECURE_NOTE" });
  });

  it("passes a null entry type when the query has no type", () => {
    search.current = new URLSearchParams("q=bank");
    const el = DashboardPage() as ReactElement;
    expect(el.props).toEqual({ view: "all", entryType: null });
  });
});
