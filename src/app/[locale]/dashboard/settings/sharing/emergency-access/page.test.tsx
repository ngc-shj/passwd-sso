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
vi.mock("@/i18n/navigation", async () =>
  (await import("@/__tests__/helpers/mock-app-navigation")).mockI18nNavigation(),
);
vi.mock("@/components/settings/account/section-card-header", () => ({
  SectionCardHeader: (props: { icon: LucideIcon; title: string; description: string }) => {
    headerProps.current = props;
    return null;
  },
}));

import EmergencyAccessSettingsPage from "./page";
import { HeartPulse } from "lucide-react";

describe("EmergencyAccessSettingsPage", () => {
  it("heads the card with the emergency-access title and the settings description", () => {
    render(<EmergencyAccessSettingsPage />);
    expect(headerProps.current).toEqual({
      icon: HeartPulse,
      title: "EmergencyAccess.title",
      description: "Settings.emergencyAccess.description",
    });
  });

  it("links the open button to the emergency-access dashboard", () => {
    render(<EmergencyAccessSettingsPage />);
    expect(screen.getByRole("link", { name: "Settings.emergencyAccess.openButton" })).toHaveAttribute(
      "href",
      "/dashboard/emergency-access",
    );
  });
});
