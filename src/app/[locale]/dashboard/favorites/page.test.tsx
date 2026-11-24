import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/components/passwords/detail/password-dashboard", () => ({ PasswordDashboard: () => null }));

import FavoritesPage from "./page";
import { PasswordDashboard } from "@/components/passwords/detail/password-dashboard";

describe("FavoritesPage", () => {
  it("renders the password dashboard in the favorites view", () => {
    const el = FavoritesPage() as ReactElement;
    expect(el.type).toBe(PasswordDashboard);
    expect(el.props).toEqual({ view: "favorites" });
  });
});
