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
  Link: ({ children, href, onClick, className, ...rest }: { children: React.ReactNode; href: string; onClick?: () => void; className?: string } & Record<string, unknown>) => (
    <a href={href} onClick={onClick} className={className} {...rest}>{children}</a>
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

import { AdminSidebar, countLeafLinks } from "./admin-sidebar";

const adminTeams = [
  { team: { id: "team-1", name: "Team Alpha", slug: "team-alpha" } },
  { team: { id: "team-2", name: "Team Beta", slug: "team-beta" } },
];

describe("countLeafLinks helper", () => {
  it("counts leaves and group children but not group headers", () => {
    const items = [
      { href: "/a", label: "a", icon: null },
      { href: "/b", label: "b", icon: null, children: [
        { href: "/b/1", label: "b1", icon: null },
        { href: "/b/2", label: "b2", icon: null },
      ] },
      { href: "/c", label: "c", icon: null },
    ];
    // 1 (leaf a) + 2 (children of b — group header itself not counted) + 1 (leaf c) = 4
    expect(countLeafLinks(items)).toBe(4);
  });
});

describe("AdminSidebar — tenant scope", () => {
  it("renders the expected number of tenant nav links", () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/members");
    render(
      <AdminSidebar
        open={false}
        onOpenChange={() => {}}
        adminTeams={adminTeams}
        hasTenantRole={true}
      />
    );

    // New tenant IA: 4 leaves (members, teams, audit-logs, breakglass)
    // + machine-identity group with 3 children
    // + policies group with 4 children
    // + integrations group with 3 children
    // = 4 + 3 + 4 + 3 = 14 links per sidebar (group headers render as <div>, not <a>)
    // × 2 sidebars (desktop + mobile sheet) = 28
    const links = screen.getAllByRole("link");
    expect(links.length).toBe(28);
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
      // Top-level leaves
      "/admin/tenant/members",
      "/admin/tenant/teams",
      "/admin/tenant/audit-logs",
      "/admin/tenant/breakglass",
      // Machine identity group children
      "/admin/tenant/machine-identity/service-accounts",
      "/admin/tenant/machine-identity/mcp-clients",
      "/admin/tenant/machine-identity/operator-tokens",
      // Policies group children
      "/admin/tenant/policies/authentication",
      "/admin/tenant/policies/machine-identity",
      "/admin/tenant/policies/retention",
      "/admin/tenant/policies/access-restriction",
      // Integrations group children
      "/admin/tenant/integrations/provisioning",
      "/admin/tenant/integrations/webhooks",
      "/admin/tenant/integrations/audit-delivery",
    ];

    expectedHrefs.forEach((href) => {
      const links = screen.getAllByRole("link").filter(
        (el) => el.getAttribute("href") === href
      );
      expect(links.length).toBeGreaterThan(0);
    });
  });

  it("active leaf link emits aria-current=page", () => {
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
      expect(link).toHaveAttribute("aria-current", "page");
    });
  });

  it("non-active leaf link does not emit aria-current", () => {
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
      expect(link).not.toHaveAttribute("aria-current");
    });
  });

  it("active child link under machine-identity group emits aria-current=page", () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/machine-identity/mcp-clients");
    render(
      <AdminSidebar
        open={false}
        onOpenChange={() => {}}
        adminTeams={adminTeams}
        hasTenantRole={true}
      />
    );

    const activeLinks = screen.getAllByRole("link").filter(
      (el) => el.getAttribute("href") === "/admin/tenant/machine-identity/mcp-clients"
    );
    expect(activeLinks.length).toBeGreaterThan(0);
    activeLinks.forEach((link) => {
      expect(link).toHaveAttribute("aria-current", "page");
    });
  });

  it("active child link under policies group emits aria-current=page", () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/policies/authentication/password");
    render(
      <AdminSidebar
        open={false}
        onOpenChange={() => {}}
        adminTeams={adminTeams}
        hasTenantRole={true}
      />
    );

    const activeLinks = screen.getAllByRole("link").filter(
      (el) => el.getAttribute("href") === "/admin/tenant/policies/authentication"
    );
    expect(activeLinks.length).toBeGreaterThan(0);
    activeLinks.forEach((link) => {
      expect(link).toHaveAttribute("aria-current", "page");
    });
  });
});

describe("AdminSidebar — team scope", () => {
  it("renders the expected number of team nav links", () => {
    mockUsePathname.mockReturnValue("/ja/admin/teams/team-1/general");
    render(
      <AdminSidebar
        open={false}
        onOpenChange={() => {}}
        adminTeams={adminTeams}
        hasTenantRole={true}
      />
    );

    // New team IA: 6 leaves (general, members, policy, key-rotation, webhooks, audit-logs)
    // × 2 sidebars (desktop + mobile sheet) = 12
    const links = screen.getAllByRole("link");
    expect(links.length).toBe(12);
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
      "/admin/teams/team-1/policy",
      "/admin/teams/team-1/key-rotation",
      "/admin/teams/team-1/webhooks",
      "/admin/teams/team-1/audit-logs",
    ];

    expectedHrefs.forEach((href) => {
      const links = screen.getAllByRole("link").filter(
        (el) => el.getAttribute("href") === href
      );
      expect(links.length).toBeGreaterThan(0);
    });
  });

  it("active leaf link for team scope emits aria-current=page", () => {
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
      expect(link).toHaveAttribute("aria-current", "page");
    });
  });
});
