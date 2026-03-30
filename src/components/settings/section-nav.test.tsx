// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockUsePathname } = vi.hoisted(() => ({
  // usePathname returns locale-prefixed paths in production; tests mirror that
  mockUsePathname: vi.fn(() => "/ja/admin/tenant/security/session-policy"),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

vi.mock("@/i18n/locale-utils", () => ({
  stripLocalePrefix: (p: string) => p.replace(/^\/[a-z]{2}/, ""),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    asChild,
    variant,
    size: _size,
    className,
    ...rest
  }: React.ComponentProps<"button"> & { asChild?: boolean; variant?: string; size?: string }) => {
    const props = { "data-variant": variant, className, ...rest } as React.HTMLAttributes<HTMLElement>;
    return asChild ? (
      <span {...props}>{children}</span>
    ) : (
      <button {...props}>{children}</button>
    );
  },
}));

import { SectionNav } from "./section-nav";
import { Shield, Globe, Webhook } from "lucide-react";

const navItems = [
  { href: "/admin/tenant/security/session-policy", label: "Session Policy", icon: Shield },
  { href: "/admin/tenant/security/sso", label: "SSO", icon: Globe },
  { href: "/admin/tenant/security/webhooks", label: "Webhooks", icon: Webhook },
];

describe("SectionNav", () => {
  it("renders all nav items with correct hrefs", () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/security/session-policy");
    render(<SectionNav items={navItems} />);

    const links = screen.getAllByRole("link");
    const hrefs = links.map((l) => l.getAttribute("href"));
    expect(hrefs).toContain("/admin/tenant/security/session-policy");
    expect(hrefs).toContain("/admin/tenant/security/sso");
    expect(hrefs).toContain("/admin/tenant/security/webhooks");
  });

  it("renders all nav item labels", () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/security/session-policy");
    render(<SectionNav items={navItems} />);

    expect(screen.getAllByText("Session Policy").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SSO").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Webhooks").length).toBeGreaterThan(0);
  });

  it("applies secondary variant to active item (desktop nav)", () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/security/session-policy");
    const { container } = render(<SectionNav items={navItems} />);

    // Desktop nav is the first nav element
    const desktopNav = container.querySelector("nav");
    expect(desktopNav).not.toBeNull();
    const activeWrapper = desktopNav!.querySelector(
      'a[href="/admin/tenant/security/session-policy"]'
    )?.parentElement;
    expect(activeWrapper).toHaveAttribute("data-variant", "secondary");
  });

  it("applies ghost variant to non-active item (desktop nav)", () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/security/session-policy");
    const { container } = render(<SectionNav items={navItems} />);

    const desktopNav = container.querySelector("nav");
    const inactiveWrapper = desktopNav!.querySelector(
      'a[href="/admin/tenant/security/webhooks"]'
    )?.parentElement;
    expect(inactiveWrapper).toHaveAttribute("data-variant", "ghost");
  });

  it("does not mark /admin/tenant/security/webhooks as active when pathname is /admin/tenant/security/session-policy", () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/security/session-policy");
    const { container } = render(<SectionNav items={navItems} />);

    const desktopNav = container.querySelector("nav");
    const webhookWrapper = desktopNav!.querySelector(
      'a[href="/admin/tenant/security/webhooks"]'
    )?.parentElement;
    expect(webhookWrapper).not.toHaveAttribute("data-variant", "secondary");
  });

  it("uses prefix matching: sub-path activates parent nav item", () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/security/session-policy/sub");
    const { container } = render(<SectionNav items={navItems} />);

    const desktopNav = container.querySelector("nav");
    const activeWrapper = desktopNav!.querySelector(
      'a[href="/admin/tenant/security/session-policy"]'
    )?.parentElement;
    expect(activeWrapper).toHaveAttribute("data-variant", "secondary");
  });

  it("does not activate non-matching items under prefix matching", () => {
    mockUsePathname.mockReturnValue("/ja/admin/tenant/security/session-policy/sub");
    const { container } = render(<SectionNav items={navItems} />);

    const desktopNav = container.querySelector("nav");
    const ssoWrapper = desktopNav!.querySelector(
      'a[href="/admin/tenant/security/sso"]'
    )?.parentElement;
    expect(ssoWrapper).toHaveAttribute("data-variant", "ghost");
  });
});
