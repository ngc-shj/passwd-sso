// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href, onClick }: { children: React.ReactNode; href: string; onClick?: () => void }) => (
    <a href={href} onClick={onClick}>{children}</a>
  ),
}));

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, asChild, ...rest }: React.ComponentProps<"button"> & { asChild?: boolean }) =>
    asChild ? <>{children}</> : <button {...rest}>{children}</button>,
}));

vi.mock("@/components/layout/sidebar-shared", () => ({
  CollapsibleSectionHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { SecuritySection, UtilitiesSection } from "./sidebar-section-security";

describe("SecuritySection", () => {
  it("renders watchtower and emergency access links", () => {
    render(
      <SecuritySection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        isWatchtower={false}
        isEmergencyAccess={false}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "watchtower" })).toHaveAttribute("href", "/dashboard/watchtower");
    expect(screen.getByRole("link", { name: "emergencyAccess" })).toHaveAttribute("href", "/dashboard/emergency-access");
  });
});

describe("UtilitiesSection", () => {
  it("shows org settings link for admin", () => {
    render(
      <UtilitiesSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        tOrg={(k) => k}
        selectedOrg={{ id: "org-1", name: "Acme", role: "ADMIN" }}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "orgSettings" })).toHaveAttribute(
      "href",
      "/dashboard/teams/org-1/settings"
    );
  });

  it("hides org settings link for member", () => {
    render(
      <UtilitiesSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        tOrg={(k) => k}
        selectedOrg={{ id: "org-1", name: "Acme", role: "MEMBER" }}
        onNavigate={() => {}}
      />
    );

    expect(screen.queryByRole("link", { name: "orgSettings" })).toBeNull();
  });

  it("shows settings and org settings links in personal context", () => {
    render(
      <UtilitiesSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        tOrg={(k) => k}
        selectedOrg={null}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "settings" })).toHaveAttribute(
      "href",
      "/dashboard/settings"
    );
    expect(screen.getByRole("link", { name: "orgSettings" })).toHaveAttribute(
      "href",
      "/dashboard/teams"
    );
  });

  it("hides settings link when org is selected", () => {
    render(
      <UtilitiesSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        tOrg={(k) => k}
        selectedOrg={{ id: "org-1", name: "Acme", role: "ADMIN" }}
        onNavigate={() => {}}
      />
    );

    expect(screen.queryByRole("link", { name: "settings" })).toBeNull();
  });

  it("routes import/export to org pages when org is selected", () => {
    render(
      <UtilitiesSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        tOrg={(k) => k}
        selectedOrg={{ id: "org-1", name: "Acme", role: "MEMBER" }}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "export" })).toHaveAttribute(
      "href",
      "/dashboard/teams/org-1/export"
    );
    expect(screen.getByRole("link", { name: "import" })).toHaveAttribute(
      "href",
      "/dashboard/teams/org-1/import"
    );
  });
});
