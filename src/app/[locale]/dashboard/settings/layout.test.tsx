// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  children?: NavItem[];
}

const { layoutProps } = vi.hoisted(() => ({
  layoutProps: {
    current: undefined as { icon: LucideIcon; title: string; navItems: NavItem[] } | undefined,
  },
}));

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock("@/components/settings/account/section-layout", () => ({
  SectionLayout: ({
    children,
    ...props
  }: { children: ReactNode; icon: LucideIcon; title: string; navItems: NavItem[] }) => {
    layoutProps.current = props;
    return <main>{children}</main>;
  },
}));

import SettingsLayout from "./layout";
import { Fingerprint, UserRound } from "lucide-react";
import { PASSKEY_PAGE_PATH } from "@/lib/constants/auth/page-path";

type NavShape = { href: string; label: string; children?: NavShape[] };

function shape(items: NavItem[]): NavShape[] {
  return items.map(({ href, label, children }) =>
    children ? { href, label, children: shape(children) } : { href, label },
  );
}

function renderLayout() {
  render(
    <SettingsLayout>
      <p>settings body</p>
    </SettingsLayout>,
  );
  if (!layoutProps.current) throw new Error("SectionLayout was not rendered");
  return layoutProps.current;
}

describe("SettingsLayout", () => {
  it("renders the settings page inside the section layout", () => {
    renderLayout();
    expect(screen.getByText("settings body")).toBeInTheDocument();
  });

  it("titles the layout with the settings root title and icon", () => {
    const props = renderLayout();
    expect(props.title).toBe("Settings.rootTitle");
    expect(props.icon).toBe(UserRound);
  });

  it("links every section and sub-tab to its settings route", () => {
    expect(shape(renderLayout().navItems)).toEqual([
      {
        href: "/dashboard/settings/account",
        label: "Settings.section.account",
        children: [
          { href: "/dashboard/settings/account/profile", label: "Settings.subTab.profile" },
          { href: "/dashboard/settings/account/notifications", label: "Settings.subTab.notifications" },
        ],
      },
      {
        href: "/dashboard/settings/auth",
        label: "Settings.section.auth",
        children: [
          { href: "/dashboard/settings/auth/passphrase", label: "Settings.subTab.passphrase" },
          { href: "/dashboard/settings/auth/recovery-key", label: "Settings.subTab.recoveryKey" },
          { href: PASSKEY_PAGE_PATH, label: "Settings.subTab.passkey" },
        ],
      },
      { href: "/dashboard/settings/devices", label: "Settings.section.devices" },
      {
        href: "/dashboard/settings/vault",
        label: "Settings.section.vault",
        children: [
          { href: "/dashboard/settings/vault/key-rotation", label: "Settings.subTab.keyRotation" },
          { href: "/dashboard/settings/vault/delegation", label: "Settings.subTab.delegation" },
          { href: "/dashboard/settings/vault/travel-mode", label: "Settings.subTab.travelMode" },
        ],
      },
      { href: "/dashboard/settings/sharing/emergency-access", label: "Settings.section.sharing" },
      {
        href: "/dashboard/settings/developer",
        label: "Settings.section.developer",
        children: [
          { href: "/dashboard/settings/developer/api-keys", label: "Settings.subTab.apiKey" },
          { href: "/dashboard/settings/developer/mcp-connections", label: "Settings.subTab.mcpConnections" },
        ],
      },
    ]);
  });

  it("marks the passkey sub-tab with the fingerprint icon", () => {
    const auth = renderLayout().navItems.find((item) => item.href === "/dashboard/settings/auth");
    const passkey = auth?.children?.find((item) => item.href === PASSKEY_PAGE_PATH);
    expect(passkey?.icon).toBe(Fingerprint);
  });
});
