// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockUsePathname } = vi.hoisted(() => ({
  // usePathname returns locale-prefixed paths in production; tests mirror that
  mockUsePathname: vi.fn(() => "/ja/dashboard/settings/auth/passkey"),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    children,
    href,
    className,
    "aria-current": ariaCurrent,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
    "aria-current"?: "page";
  }) => (
    <a href={href} className={className} aria-current={ariaCurrent}>{children}</a>
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
  { href: "/dashboard/settings/auth/passkey", label: "Session Policy", icon: Shield },
  { href: "/dashboard/settings/auth/recovery-key", label: "SSO", icon: Globe },
  { href: "/dashboard/settings/devices", label: "Webhooks", icon: Webhook },
];

describe("SectionNav", () => {
  it("renders all nav items with correct hrefs", () => {
    mockUsePathname.mockReturnValue("/ja/dashboard/settings/auth/passkey");
    render(<SectionNav items={navItems} />);

    const links = screen.getAllByRole("link");
    const hrefs = links.map((l) => l.getAttribute("href"));
    expect(hrefs).toContain("/dashboard/settings/auth/passkey");
    expect(hrefs).toContain("/dashboard/settings/auth/recovery-key");
    expect(hrefs).toContain("/dashboard/settings/devices");
  });

  it("renders all nav item labels", () => {
    mockUsePathname.mockReturnValue("/ja/dashboard/settings/auth/passkey");
    render(<SectionNav items={navItems} />);

    expect(screen.getAllByText("Session Policy").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SSO").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Webhooks").length).toBeGreaterThan(0);
  });

  it("applies secondary variant to active item (desktop nav)", () => {
    mockUsePathname.mockReturnValue("/ja/dashboard/settings/auth/passkey");
    const { container } = render(<SectionNav items={navItems} />);

    // Desktop nav is the first nav element
    const desktopNav = container.querySelector("nav");
    expect(desktopNav).not.toBeNull();
    const activeWrapper = desktopNav!.querySelector(
      'a[href="/dashboard/settings/auth/passkey"]'
    )?.parentElement;
    expect(activeWrapper).toHaveAttribute("data-variant", "secondary");
  });

  it("applies ghost variant to non-active item (desktop nav)", () => {
    mockUsePathname.mockReturnValue("/ja/dashboard/settings/auth/passkey");
    const { container } = render(<SectionNav items={navItems} />);

    const desktopNav = container.querySelector("nav");
    const inactiveWrapper = desktopNav!.querySelector(
      'a[href="/dashboard/settings/devices"]'
    )?.parentElement;
    expect(inactiveWrapper).toHaveAttribute("data-variant", "ghost");
  });

  it("does not mark /dashboard/settings/devices as active when pathname is /dashboard/settings/auth/passkey", () => {
    mockUsePathname.mockReturnValue("/ja/dashboard/settings/auth/passkey");
    const { container } = render(<SectionNav items={navItems} />);

    const desktopNav = container.querySelector("nav");
    const webhookWrapper = desktopNav!.querySelector(
      'a[href="/dashboard/settings/devices"]'
    )?.parentElement;
    expect(webhookWrapper).not.toHaveAttribute("data-variant", "secondary");
  });

  it("uses prefix matching: sub-path activates parent nav item", () => {
    mockUsePathname.mockReturnValue("/ja/dashboard/settings/auth/passkey/sub");
    const { container } = render(<SectionNav items={navItems} />);

    const desktopNav = container.querySelector("nav");
    const activeWrapper = desktopNav!.querySelector(
      'a[href="/dashboard/settings/auth/passkey"]'
    )?.parentElement;
    expect(activeWrapper).toHaveAttribute("data-variant", "secondary");
  });

  it("does not activate non-matching items under prefix matching", () => {
    mockUsePathname.mockReturnValue("/ja/dashboard/settings/auth/passkey/sub");
    const { container } = render(<SectionNav items={navItems} />);

    const desktopNav = container.querySelector("nav");
    const ssoWrapper = desktopNav!.querySelector(
      'a[href="/dashboard/settings/auth/recovery-key"]'
    )?.parentElement;
    expect(ssoWrapper).toHaveAttribute("data-variant", "ghost");
  });

  it("marks only the active leaf link with aria-current=page", () => {
    mockUsePathname.mockReturnValue("/ja/dashboard/settings/devices");
    const { container } = render(<SectionNav items={navItems} />);

    const [desktopNav] = container.querySelectorAll("nav");
    expect(desktopNav.querySelector('a[href="/dashboard/settings/devices"]')).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      desktopNav.querySelector('a[href="/dashboard/settings/auth/passkey"]'),
    ).not.toHaveAttribute("aria-current");
  });

  it("uses the outline variant for inactive leaf pills on mobile", () => {
    mockUsePathname.mockReturnValue("/ja/dashboard/settings/auth/passkey");
    const { container } = render(<SectionNav items={navItems} />);

    const mobileNav = container.querySelectorAll("nav")[1];
    expect(
      mobileNav.querySelector('a[href="/dashboard/settings/devices"]')?.parentElement,
    ).toHaveAttribute("data-variant", "outline");
    expect(
      mobileNav.querySelector('a[href="/dashboard/settings/auth/passkey"]')?.parentElement,
    ).toHaveAttribute("data-variant", "secondary");
  });
});

describe("SectionNav with grouped items", () => {
  const groupedItems = [
    {
      href: "/dashboard/settings/auth",
      label: "Authentication",
      icon: Shield,
      children: [
        { href: "/dashboard/settings/auth/passkey", label: "Passkeys", icon: Shield },
        { href: "/dashboard/settings/auth/recovery-key", label: "Recovery key", icon: Globe },
      ],
    },
    { href: "/dashboard/settings/devices", label: "Devices", icon: Webhook },
  ];

  it("renders the group header as text, not a link", () => {
    mockUsePathname.mockReturnValue("/ja/dashboard/settings/devices");
    render(<SectionNav items={groupedItems} />);

    expect(screen.getByText("Authentication")).toBeInTheDocument();
    const hrefs = screen.getAllByRole("link").map((l) => l.getAttribute("href"));
    expect(hrefs).not.toContain("/dashboard/settings/auth");
    expect(hrefs).toContain("/dashboard/settings/auth/passkey");
  });

  it("highlights the group header when one of its children is active", () => {
    mockUsePathname.mockReturnValue("/ja/dashboard/settings/auth/recovery-key");
    const { rerender } = render(<SectionNav items={groupedItems} />);
    expect(screen.getByText("Authentication").parentElement).toHaveClass("text-foreground");

    mockUsePathname.mockReturnValue("/ja/dashboard/settings/devices");
    rerender(<SectionNav items={groupedItems} />);
    expect(screen.getByText("Authentication").parentElement).toHaveClass("text-muted-foreground");
  });

  it("marks the active child in the desktop nav", () => {
    mockUsePathname.mockReturnValue("/ja/dashboard/settings/auth/recovery-key");
    const { container } = render(<SectionNav items={groupedItems} />);

    const [desktopNav] = container.querySelectorAll("nav");
    const active = desktopNav.querySelector('a[href="/dashboard/settings/auth/recovery-key"]');
    const inactive = desktopNav.querySelector('a[href="/dashboard/settings/auth/passkey"]');
    expect(active?.parentElement).toHaveAttribute("data-variant", "secondary");
    expect(active).toHaveAttribute("aria-current", "page");
    expect(inactive?.parentElement).toHaveAttribute("data-variant", "ghost");
    expect(inactive).not.toHaveAttribute("aria-current");
  });

  it("flattens children into mobile pills and marks the active one", () => {
    mockUsePathname.mockReturnValue("/ja/dashboard/settings/auth/recovery-key");
    const { container } = render(<SectionNav items={groupedItems} />);

    const mobileNav = container.querySelectorAll("nav")[1];
    const hrefs = Array.from(mobileNav.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "/dashboard/settings/auth/passkey",
      "/dashboard/settings/auth/recovery-key",
      "/dashboard/settings/devices",
    ]);
    const active = mobileNav.querySelector('a[href="/dashboard/settings/auth/recovery-key"]');
    expect(active?.parentElement).toHaveAttribute("data-variant", "secondary");
    expect(active).toHaveAttribute("aria-current", "page");
    expect(
      mobileNav.querySelector('a[href="/dashboard/settings/auth/passkey"]')?.parentElement,
    ).toHaveAttribute("data-variant", "outline");
  });
});

