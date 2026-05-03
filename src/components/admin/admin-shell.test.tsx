// @vitest-environment jsdom
/**
 * AdminShell — orchestration test
 *
 * §Sec-3: cross-tenant denial — admin components are gated by props
 * (adminTeams + hasTenantRole). When those are empty / false (i.e. no
 * authority on the current tenant), the AdminSidebar's content
 * (admin-only items) MUST NOT render. We verify that AdminShell forwards
 * those props so the sidebar can fall back to an empty render.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { capturedSidebarProps } = vi.hoisted(() => ({
  capturedSidebarProps: {} as Record<string, unknown>,
}));

vi.mock("./admin-header", () => ({
  AdminHeader: ({ onMenuToggle }: { onMenuToggle: () => void }) => (
    <button data-testid="menu-toggle" onClick={onMenuToggle}>
      header
    </button>
  ),
}));

vi.mock("./admin-sidebar", () => ({
  AdminSidebar: (props: {
    open: boolean;
    adminTeams: { team: { id: string } }[];
    hasTenantRole: boolean;
  }) => {
    Object.assign(capturedSidebarProps, props);
    return (
      <div
        data-testid="admin-sidebar"
        data-open={props.open ? "true" : "false"}
        data-team-count={props.adminTeams.length}
        data-has-tenant-role={props.hasTenantRole ? "true" : "false"}
      />
    );
  },
}));

import { AdminShell } from "./admin-shell";

const teamA = { team: { id: "team-a", name: "A", slug: "a" } };
const teamB = { team: { id: "team-b", name: "B", slug: "b" } };

describe("AdminShell", () => {
  it("renders header, sidebar, and children", () => {
    render(
      <AdminShell adminTeams={[teamA]} hasTenantRole={true}>
        <p>admin content</p>
      </AdminShell>,
    );

    expect(screen.getByTestId("menu-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("admin-sidebar")).toBeInTheDocument();
    expect(screen.getByText("admin content")).toBeInTheDocument();
  });

  it("opens sidebar when header onMenuToggle fires", () => {
    render(
      <AdminShell adminTeams={[teamA]} hasTenantRole={true}>
        <p />
      </AdminShell>,
    );

    expect(screen.getByTestId("admin-sidebar").getAttribute("data-open")).toBe(
      "false",
    );

    fireEvent.click(screen.getByTestId("menu-toggle"));

    expect(screen.getByTestId("admin-sidebar").getAttribute("data-open")).toBe(
      "true",
    );
  });

  it("forwards adminTeams and hasTenantRole to sidebar", () => {
    render(
      <AdminShell adminTeams={[teamA, teamB]} hasTenantRole={true}>
        <p />
      </AdminShell>,
    );

    const sidebar = screen.getByTestId("admin-sidebar");
    expect(sidebar.getAttribute("data-team-count")).toBe("2");
    expect(sidebar.getAttribute("data-has-tenant-role")).toBe("true");
  });

  it("§Sec-3: passes empty adminTeams + hasTenantRole=false to sidebar (fallback render)", () => {
    // Cross-tenant scenario: user authenticated on tenant T, but the resource
    // they're viewing is for a tenant they have NO admin role in. Server-side
    // checks should produce empty adminTeams + hasTenantRole=false. Here we
    // verify the shell forwards those values (sidebar then renders empty per
    // its own test). Crucially: the shell does NOT crash — children + header
    // still render, providing an empty/fallback admin view rather than
    // exposing resource data.
    render(
      <AdminShell adminTeams={[]} hasTenantRole={false}>
        <p>fallback children</p>
      </AdminShell>,
    );

    const sidebar = screen.getByTestId("admin-sidebar");
    expect(sidebar.getAttribute("data-team-count")).toBe("0");
    expect(sidebar.getAttribute("data-has-tenant-role")).toBe("false");

    // No crash; children area renders
    expect(screen.getByText("fallback children")).toBeInTheDocument();
  });
});
