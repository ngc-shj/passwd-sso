// @vitest-environment jsdom
/**
 * DashboardShell — orchestrator test
 *
 * The shell composes Header + Sidebar + RecoveryKeyBanner + DelegationRevokeBanner
 * and provides ActiveVaultProvider + TravelModeProvider. We test:
 *   - Children are rendered
 *   - Each composed area gets a recognizable marker (mocked)
 *   - The sidebar's openChange wiring works (Header onMenuToggle → Sidebar `open`)
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { capturedSidebarProps } = vi.hoisted(() => ({
  capturedSidebarProps: { open: false } as { open: boolean },
}));

vi.mock("./header", () => ({
  Header: ({ onMenuToggle }: { onMenuToggle: () => void }) => (
    <button data-testid="header-menu" onClick={onMenuToggle}>
      header
    </button>
  ),
}));

vi.mock("./sidebar", () => ({
  Sidebar: ({ open }: { open: boolean }) => {
    capturedSidebarProps.open = open;
    return <div data-testid="sidebar" data-open={open ? "true" : "false"} />;
  },
}));

vi.mock("@/components/vault/recovery-key-banner", () => ({
  RecoveryKeyBanner: () => <div data-testid="recovery-key-banner" />,
}));

vi.mock("@/components/vault/delegation-revoke-banner", () => ({
  DelegationRevokeBanner: () => <div data-testid="delegation-revoke-banner" />,
}));

vi.mock("@/lib/vault/active-vault-context", () => ({
  ActiveVaultProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/use-travel-mode", () => ({
  TravelModeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { DashboardShell } from "./dashboard-shell";

describe("DashboardShell", () => {
  it("renders children, header, sidebar, recovery and delegation banners", () => {
    render(
      <DashboardShell>
        <p>page-content</p>
      </DashboardShell>,
    );

    expect(screen.getByText("page-content")).toBeInTheDocument();
    expect(screen.getByTestId("header-menu")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("recovery-key-banner")).toBeInTheDocument();
    expect(screen.getByTestId("delegation-revoke-banner")).toBeInTheDocument();
  });

  it("opens the sidebar when header onMenuToggle fires", () => {
    render(
      <DashboardShell>
        <p />
      </DashboardShell>,
    );

    expect(screen.getByTestId("sidebar").getAttribute("data-open")).toBe("false");

    fireEvent.click(screen.getByTestId("header-menu"));

    expect(screen.getByTestId("sidebar").getAttribute("data-open")).toBe("true");
  });
});
