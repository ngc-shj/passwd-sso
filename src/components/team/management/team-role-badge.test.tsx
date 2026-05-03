// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { TEAM_ROLE } from "@/lib/constants";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    className,
  }: React.ComponentProps<"span">) => (
    <span data-testid="badge" className={className}>
      {children}
    </span>
  ),
}));

import { TeamRoleBadge } from "./team-role-badge";

describe("TeamRoleBadge", () => {
  it.each([
    [TEAM_ROLE.OWNER, "roleOwner"],
    [TEAM_ROLE.ADMIN, "roleAdmin"],
    [TEAM_ROLE.MEMBER, "roleMember"],
    [TEAM_ROLE.VIEWER, "roleViewer"],
  ])("renders role label key %s -> %s", (role, expectedKey) => {
    render(<TeamRoleBadge role={role} />);
    expect(screen.getByTestId("badge")).toHaveTextContent(expectedKey);
  });

  it("falls back to roleMember label for unknown role", () => {
    render(<TeamRoleBadge role="UNKNOWN_ROLE" />);
    expect(screen.getByTestId("badge")).toHaveTextContent("roleMember");
  });

  it("applies role-specific color class for OWNER", () => {
    render(<TeamRoleBadge role={TEAM_ROLE.OWNER} />);
    const badge = screen.getByTestId("badge");
    expect(badge.className).toContain("amber");
  });

  it("applies role-specific color class for VIEWER", () => {
    render(<TeamRoleBadge role={TEAM_ROLE.VIEWER} />);
    const badge = screen.getByTestId("badge");
    expect(badge.className).toContain("gray");
  });

  it("applies empty class for unknown role color", () => {
    render(<TeamRoleBadge role="UNKNOWN" />);
    const badge = screen.getByTestId("badge");
    // Should not have any of the predefined color tokens
    expect(badge.className).not.toContain("amber");
    expect(badge.className).not.toContain("blue");
    expect(badge.className).not.toContain("green");
    expect(badge.className).not.toContain("gray");
  });
});
