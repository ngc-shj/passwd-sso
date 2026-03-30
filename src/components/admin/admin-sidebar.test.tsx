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
  Link: ({ children, href, onClick, className }: { children: React.ReactNode; href: string; onClick?: () => void; className?: string }) => (
    <a href={href} onClick={onClick} className={className}>{children}</a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/i18n/locale-utils", () => ({
  stripLocalePrefix: (p: string) => p.replace(/^\/[a-z]{2}/, ""),
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("./admin-scope-selector", () => ({
  AdminScopeSelector: () => <div data-testid="admin-scope-selector" />,
}));

vi.mock("radix-ui", () => ({
  VisuallyHidden: {
    Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
}));

import { AdminSidebar } from "./admin-sidebar";

const adminTeams = [
  { team: { id: "team-1", name: "Team Alpha", slug: "team-alpha" } },
  { team: { id: "team-2", name: "Team Beta", slug: "team-beta" } },
];

describe("AdminSidebar — tenant scope", () => {
  it("renders 6 tenant nav items when pathname is /admin/tenant/members", () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/members");
    render(
      <AdminSidebar
        open={false}
        onOpenChange={() => {}}
        adminTeams={adminTeams}
        hasTenantRole={true}
      />
    );

    const links = screen.getAllByRole("link");
    // Desktop + mobile (Sheet) render 2 sidebars: 6 × 2 = 12
    expect(links.length).toBe(12);
  });

  it("renders correct tenant nav hrefs", () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/members");
    render(
      <AdminSidebar
        open={false}
        onOpenChange={() => {}}
        adminTeams={adminTeams}
        hasTenantRole={true}
      />
    );

    const expectedHrefs = [
      "/admin/tenant/members",
      "/admin/tenant/teams",
      "/admin/tenant/security",
      "/admin/tenant/provisioning",
      "/admin/tenant/machine-identity",
      "/admin/tenant/audit-logs",
    ];

    expectedHrefs.forEach((href) => {
      const links = screen.getAllByRole("link").filter(
        (el) => el.getAttribute("href") === href
      );
      expect(links.length).toBeGreaterThan(0);
    });
  });

  it("active link has bg-accent class when pathname matches", () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/members");
    render(
      <AdminSidebar
        open={false}
        onOpenChange={() => {}}
        adminTeams={adminTeams}
        hasTenantRole={true}
      />
    );

    const activeLinks = screen.getAllByRole("link").filter(
      (el) => el.getAttribute("href") === "/admin/tenant/members"
    );
    expect(activeLinks.length).toBeGreaterThan(0);
    activeLinks.forEach((link) => {
      // Active items use "bg-accent text-accent-foreground" (no /50 suffix)
      expect(link.className).toMatch(/\bbg-accent\b(?!\/)/);
    });
  });

  it("non-active link does not have bg-accent (exact) class", () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/members");
    render(
      <AdminSidebar
        open={false}
        onOpenChange={() => {}}
        adminTeams={adminTeams}
        hasTenantRole={true}
      />
    );

    const inactiveLinks = screen.getAllByRole("link").filter(
      (el) => el.getAttribute("href") === "/admin/tenant/teams"
    );
    expect(inactiveLinks.length).toBeGreaterThan(0);
    inactiveLinks.forEach((link) => {
      // Inactive items have hover:bg-accent/50 but NOT the standalone bg-accent class
      expect(link.className).not.toMatch(/\bbg-accent\b(?!\/)/);
    });
  });
});

describe("AdminSidebar — team scope", () => {
  it("renders 4 team nav items when pathname is /admin/teams/team-1/general", () => {
    mockUsePathname.mockReturnValue("/ja/admin/teams/team-1/general");
    render(
      <AdminSidebar
        open={false}
        onOpenChange={() => {}}
        adminTeams={adminTeams}
        hasTenantRole={true}
      />
    );

    // 4 items × 2 sidebars = 8 links
    const links = screen.getAllByRole("link");
    expect(links.length).toBe(8);
  });

  it("renders correct team nav hrefs for team-1", () => {
    mockUsePathname.mockReturnValue("/ja/admin/teams/team-1/general");
    render(
      <AdminSidebar
        open={false}
        onOpenChange={() => {}}
        adminTeams={adminTeams}
        hasTenantRole={true}
      />
    );

    const expectedHrefs = [
      "/admin/teams/team-1/general",
      "/admin/teams/team-1/members",
      "/admin/teams/team-1/security",
      "/admin/teams/team-1/audit-logs",
    ];

    expectedHrefs.forEach((href) => {
      const links = screen.getAllByRole("link").filter(
        (el) => el.getAttribute("href") === href
      );
      expect(links.length).toBeGreaterThan(0);
    });
  });

  it("active link for team scope has bg-accent class", () => {
    mockUsePathname.mockReturnValue("/ja/admin/teams/team-1/general");
    render(
      <AdminSidebar
        open={false}
        onOpenChange={() => {}}
        adminTeams={adminTeams}
        hasTenantRole={true}
      />
    );

    const activeLinks = screen.getAllByRole("link").filter(
      (el) => el.getAttribute("href") === "/admin/teams/team-1/general"
    );
    expect(activeLinks.length).toBeGreaterThan(0);
    activeLinks.forEach((link) => {
      expect(link.className).toMatch(/\bbg-accent\b(?!\/)/);
    });
  });
});
