import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/components/passwords/detail/password-dashboard", () => ({ PasswordDashboard: () => null }));

import ArchivePage from "./page";
import { PasswordDashboard } from "@/components/passwords/detail/password-dashboard";

describe("ArchivePage", () => {
  it("renders the password dashboard in the archive view", () => {
    const el = ArchivePage() as ReactElement;
    expect(el.type).toBe(PasswordDashboard);
    expect(el.props).toEqual({ view: "archive" });
  });
});
