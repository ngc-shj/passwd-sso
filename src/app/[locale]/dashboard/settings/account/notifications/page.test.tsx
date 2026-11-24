// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import type { LucideIcon } from "lucide-react";

const { headerProps } = vi.hoisted(() => ({
  headerProps: {
    current: undefined as { icon: LucideIcon; title: string; description: string } | undefined,
  },
}));

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock("@/components/settings/account/section-card-header", () => ({
  SectionCardHeader: (props: { icon: LucideIcon; title: string; description: string }) => {
    headerProps.current = props;
    return null;
  },
}));

import NotificationsSettingsPage from "./page";
import { Bell } from "lucide-react";

describe("NotificationsSettingsPage", () => {
  it("heads the card with the notifications tab title, description and bell icon", () => {
    render(<NotificationsSettingsPage />);
    expect(headerProps.current).toEqual({
      icon: Bell,
      title: "Settings.subTab.notifications",
      description: "Settings.notifications.description",
    });
  });

  it("shows the coming-soon notice as the card body", () => {
    render(<NotificationsSettingsPage />);
    expect(screen.getByText("Settings.comingSoon")).toBeInTheDocument();
  });
});
