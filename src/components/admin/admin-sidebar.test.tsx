// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockUsePathname } = vi.hoisted(() => ({
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
  Slot: {
    Root: ({ children, ...props }: React.ComponentProps<"span">) => <span {...props}>{children}</span>,
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, asChild, variant, ...rest }: React.ComponentProps<"button"> & { asChild?: boolean; variant?: string }) =>
    asChild
      ? <span data-variant={variant}>{children}</span>
      : <button data-variant={variant} {...rest}>{children}</button>,
}));

import { AdminSidebar } from "./admin-sidebar";

const adminTeams = [
  { team: { id: "team-1", name: "Team Alpha", slug: "team-alpha" } },
  { team: { id: "team-2", name: "Team Beta", slug: "team-beta" } },
];

describe("AdminSidebar — tenant scope", () => {
  it("renders tenant leaf and child nav links", () => {
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
    // Leaf items (members, teams) + children under groups (security×3, provisioning×2, machine-identity×3, audit-logs×2)
    // = 2 leaf + 10 children = 12 per sidebar × 2 sidebars = 24
    expect(links.length).toBe(24);
  });

  it("renders correct tenant nav hrefs including children", () => {
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
      "/admin/tenant/security/session-policy",
      "/admin/tenant/security/access-restriction",
      "/admin/tenant/security/webhooks",
      "/admin/tenant/provisioning/scim",
      "/admin/tenant/provisioning/directory-sync",
      "/admin/tenant/machine-identity/service-accounts",
      "/admin/tenant/machine-identity/mcp-clients",
      "/admin/tenant/machine-identity/access-requests",
      "/admin/tenant/audit-logs/logs",
      "/admin/tenant/audit-logs/breakglass",
    ];

    expectedHrefs.forEach((href) => {
      const links = screen.getAllByRole("link").filter(
        (el) => el.getAttribute("href") === href
      );
      expect(links.length).toBeGreaterThan(0);
    });
  });

  it("active leaf link has secondary variant", () => {
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
      // Button wraps the link — check parent for variant
      expect(link.parentElement?.getAttribute("data-variant")).toBe("secondary");
    });
  });

  it("non-active leaf link has ghost variant", () => {
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
      expect(link.parentElement?.getAttribute("data-variant")).toBe("ghost");
    });
  });
});

describe("AdminSidebar — team scope", () => {
  it("renders team leaf and child nav links", () => {
    mockUsePathname.mockReturnValue("/ja/admin/teams/team-1/general");
    render(
      <AdminSidebar
        open={false}
        onOpenChange={() => {}}
        adminTeams={adminTeams}
        hasTenantRole={true}
      />
    );

    const links = screen.getAllByRole("link");
    // Leaf items (general, audit-logs) + children under groups (members×3, security×3)
    // = 2 leaf + 6 children = 8 per sidebar × 2 sidebars = 16
    expect(links.length).toBe(16);
  });

  it("renders correct team nav hrefs for team-1 including children", () => {
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
      "/admin/teams/team-1/members/list",
      "/admin/teams/team-1/members/add",
      "/admin/teams/team-1/members/transfer",
      "/admin/teams/team-1/security/policy",
      "/admin/teams/team-1/security/key-rotation",
      "/admin/teams/team-1/security/webhooks",
      "/admin/teams/team-1/audit-logs",
    ];

    expectedHrefs.forEach((href) => {
      const links = screen.getAllByRole("link").filter(
        (el) => el.getAttribute("href") === href
      );
      expect(links.length).toBeGreaterThan(0);
    });
  });

  it("active leaf link for team scope has secondary variant", () => {
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
      expect(link.parentElement?.getAttribute("data-variant")).toBe("secondary");
    });
  });
});
