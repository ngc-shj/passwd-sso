import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/components/passwords/detail/password-dashboard", () => ({ PasswordDashboard: () => null }));

import TrashPage from "./page";
import { PasswordDashboard } from "@/components/passwords/detail/password-dashboard";

describe("TrashPage", () => {
  it("renders the password dashboard in the trash view", () => {
    const el = TrashPage() as ReactElement;
    expect(el.type).toBe(PasswordDashboard);
    expect(el.props).toEqual({ view: "trash" });
  });
});
