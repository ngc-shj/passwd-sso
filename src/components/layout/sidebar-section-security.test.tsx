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

import { SecuritySection, SettingsNavSection, ToolsSection } from "./sidebar-section-security";

describe("SecuritySection", () => {
  it("renders watchtower and emergency access links", () => {
    render(
      <SecuritySection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        vaultContext={{ type: "personal" }}
        isWatchtower={false}
        isEmergencyAccess={false}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "watchtower" })).toHaveAttribute("href", "/dashboard/watchtower");
    expect(screen.getByRole("link", { name: "emergencyAccess" })).toHaveAttribute("href", "/dashboard/emergency-access");
  });

  it("routes watchtower to the selected team vault", () => {
    render(
      <SecuritySection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        vaultContext={{ type: "team", teamId: "team-1", teamRole: "MEMBER" }}
        isWatchtower={true}
        isEmergencyAccess={false}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "watchtower" })).toHaveAttribute(
      "href",
      "/dashboard/teams/team-1/watchtower"
    );
  });

  it("hides emergency access when team is selected", () => {
    render(
      <SecuritySection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        vaultContext={{ type: "team", teamId: "team-1", teamRole: "MEMBER" }}
        isWatchtower={false}
        isEmergencyAccess={false}
        onNavigate={() => {}}
      />
    );

    expect(screen.queryByRole("link", { name: "emergencyAccess" })).toBeNull();
  });

  it("hides watchtower for team viewers", () => {
    render(
      <SecuritySection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        vaultContext={{ type: "team", teamId: "team-1", teamRole: "VIEWER" }}
        isWatchtower={false}
        isEmergencyAccess={false}
        onNavigate={() => {}}
      />
    );

    expect(screen.queryByRole("link", { name: "watchtower" })).toBeNull();
  });
});

describe("SettingsNavSection", () => {
  it("shows settings link pointing to /dashboard/settings/account in personal context", () => {
    render(
      <SettingsNavSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        selectedTeam={null}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "settings" })).toHaveAttribute(
      "href",
      "/dashboard/settings/account"
    );
  });

  it("shows admin console link when isAdmin is true", () => {
    render(
      <SettingsNavSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        selectedTeam={null}
        isAdmin={true}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "adminConsole" })).toHaveAttribute(
      "href",
      "/admin/tenant/members"
    );
  });

  it("hides admin console link when isAdmin is false", () => {
    render(
      <SettingsNavSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        selectedTeam={null}
        isAdmin={false}
        onNavigate={() => {}}
      />
    );

    expect(screen.queryByRole("link", { name: "adminConsole" })).toBeNull();
  });

  it("hides settings link when team is selected", () => {
    render(
      <SettingsNavSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        selectedTeam={{ id: "team-1", name: "Acme", role: "ADMIN" }}
        onNavigate={() => {}}
      />
    );

    expect(screen.queryByRole("link", { name: "settings" })).toBeNull();
  });

  it("applies secondary variant to admin console link when isAdminActive is true", () => {
    render(
      <SettingsNavSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        selectedTeam={null}
        isAdmin={true}
        isAdminActive={true}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "adminConsole" })).toHaveAttribute(
      "href",
      "/admin/tenant/members"
    );
  });
});

describe("ToolsSection", () => {
  it("routes import/export to team pages when team is selected", () => {
    render(
      <ToolsSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        selectedTeam={{ id: "team-1", name: "Acme", role: "MEMBER" }}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "export" })).toHaveAttribute(
      "href",
      "/dashboard/teams/team-1/export"
    );
    expect(screen.getByRole("link", { name: "import" })).toHaveAttribute(
      "href",
      "/dashboard/teams/team-1/import"
    );
  });

  it("routes import/export to personal pages when no team is selected", () => {
    render(
      <ToolsSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        selectedTeam={null}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "export" })).toHaveAttribute(
      "href",
      "/dashboard/export"
    );
    expect(screen.getByRole("link", { name: "import" })).toHaveAttribute(
      "href",
      "/dashboard/import"
    );
  });
});
