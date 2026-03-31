// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

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
  SelectItem: ({ value }: { children: React.ReactNode; value: string }) => (
    <option value={value} data-value={value}>{value}</option>
  ),
}));

import { AdminScopeSelector } from "./admin-scope-selector";

const adminTeams = [
  { team: { id: "team-1", name: "Team Alpha", slug: "team-alpha" } },
  { team: { id: "team-2", name: "Team Beta", slug: "team-beta" } },
];

describe("AdminScopeSelector", () => {
  it('renders "tenant" option when hasTenantRole=true', () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/members");
    render(<AdminScopeSelector adminTeams={adminTeams} hasTenantRole={true} />);

    const option = screen.getByRole("option", { name: "tenant" });
    expect(option).toBeInTheDocument();
    expect(option).toHaveValue("tenant");
  });

  it('does NOT render "tenant" option when hasTenantRole=false', () => {
    mockUsePathname.mockReturnValue("/ja/admin/teams/team-1/general");
    render(<AdminScopeSelector adminTeams={adminTeams} hasTenantRole={false} />);

    expect(screen.queryByRole("option", { name: "tenant" })).toBeNull();
  });

  it("always renders team options from adminTeams prop", () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/members");
    render(<AdminScopeSelector adminTeams={adminTeams} hasTenantRole={true} />);

    expect(screen.getByRole("option", { name: "team-1" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "team-2" })).toBeInTheDocument();
  });

  it("renders team options even when hasTenantRole=false", () => {
    mockUsePathname.mockReturnValue("/ja/admin/teams/team-1/general");
    render(<AdminScopeSelector adminTeams={adminTeams} hasTenantRole={false} />);

    expect(screen.getByRole("option", { name: "team-1" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "team-2" })).toBeInTheDocument();
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
