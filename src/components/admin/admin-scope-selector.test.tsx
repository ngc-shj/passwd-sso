// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

function textContent(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(" ");
  if (React.isValidElement(node)) {
    const props = node.props as {
      children?: React.ReactNode;
      name?: string;
      tenantName?: string;
      isCrossTenant?: boolean;
    };
    if (typeof props.name === "string") {
      return props.isCrossTenant && props.tenantName
        ? `${props.name} ${props.tenantName}`
        : props.name;
    }
    return textContent(props.children);
  }
  return "";
}

const { mockUsePathname } = vi.hoisted(() => ({
  // usePathname returns locale-prefixed paths in production; tests mirror that
  mockUsePathname: vi.fn(() => "/ja/admin/tenant/members"),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/i18n/locale-utils", () => ({
  stripLocalePrefix: (p: string) => p.replace(/^\/[a-z]{2}/, ""),
}));
// Render Select as a simple native select so SelectItem values are testable
vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange?: (v: string) => void;
  }) => (
    <select
      data-testid="scope-select"
      value={value}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { children: React.ReactNode; value: string }) => (
    <option value={value} data-value={value}>{textContent(children)}</option>
  ),
}));

import { AdminScopeSelector } from "./admin-scope-selector";
import type { AdminTeamMembership } from "@/lib/auth/access/team-auth";
import { TEAM_ROLE } from "@/lib/constants";

function membership(
  team: AdminTeamMembership["team"],
): AdminTeamMembership {
  return {
    id: `member-${team.id}`,
    teamId: team.id,
    userId: "user-1",
    tenantId: "tenant-1",
    role: TEAM_ROLE.ADMIN,
    keyDistributed: true,
    deactivatedAt: null,
    scimManaged: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    team,
  };
}

const adminTeams: AdminTeamMembership[] = [
  membership({ id: "team-1", name: "Team Alpha", slug: "team-alpha", tenantName: "Home Tenant", isCrossTenant: false }),
  membership({ id: "team-2", name: "Team Beta", slug: "team-beta", tenantName: "Guest Tenant", isCrossTenant: true }),
];

describe("AdminScopeSelector", () => {
  it('renders "tenant" option when hasTenantRole=true', () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/members");
    render(<AdminScopeSelector adminTeams={adminTeams} hasTenantRole={true} />);

    const option = screen.getByRole("option", { name: "scopeTenant" });
    expect(option).toBeInTheDocument();
    expect(option).toHaveValue("tenant");
  });

  it('does NOT render "tenant" option when hasTenantRole=false', () => {
    mockUsePathname.mockReturnValue("/ja/admin/teams/team-1/general");
    render(<AdminScopeSelector adminTeams={adminTeams} hasTenantRole={false} />);

    expect(screen.queryByRole("option", { name: "scopeTenant" })).toBeNull();
  });

  it("always renders team options from adminTeams prop", () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/members");
    render(<AdminScopeSelector adminTeams={adminTeams} hasTenantRole={true} />);

    expect(screen.getByRole("option", { name: "Team Alpha" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Team Beta Guest Tenant" })).toBeInTheDocument();
  });

  it("renders team options even when hasTenantRole=false", () => {
    mockUsePathname.mockReturnValue("/ja/admin/teams/team-1/general");
    render(<AdminScopeSelector adminTeams={adminTeams} hasTenantRole={false} />);

    expect(screen.getByRole("option", { name: "Team Alpha" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Team Beta Guest Tenant" })).toBeInTheDocument();
  });

  it('detects current scope as "tenant" for /admin/tenant/members', () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/members");
    render(<AdminScopeSelector adminTeams={adminTeams} hasTenantRole={true} />);

    const select = screen.getByTestId("scope-select") as HTMLSelectElement;
    expect(select.value).toBe("tenant");
  });

  it("detects current scope as team-1 for /admin/teams/team-1/general", () => {
    mockUsePathname.mockReturnValue("/ja/admin/teams/team-1/general");
    render(<AdminScopeSelector adminTeams={adminTeams} hasTenantRole={true} />);

    const select = screen.getByTestId("scope-select") as HTMLSelectElement;
    expect(select.value).toBe("team-1");
  });

  it("detects team scope from nested team path", () => {
    mockUsePathname.mockReturnValue("/ja/admin/teams/team-2/members");
    render(<AdminScopeSelector adminTeams={adminTeams} hasTenantRole={true} />);

    const select = screen.getByTestId("scope-select") as HTMLSelectElement;
    expect(select.value).toBe("team-2");
  });
});
