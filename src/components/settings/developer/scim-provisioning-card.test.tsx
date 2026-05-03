// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next-intl", () => ({
  useLocale: () => "en",
}));

vi.mock("@/components/team/security/team-scim-token-manager", () => ({
  ScimTokenManager: ({ locale }: { locale: string }) => (
    <div data-testid="scim-token-manager" data-locale={locale}>
      Scim Manager
    </div>
  ),
}));

import { ScimProvisioningCard } from "./scim-provisioning-card";

describe("ScimProvisioningCard", () => {
  it("delegates to ScimTokenManager and forwards the current locale", () => {
    render(<ScimProvisioningCard />);
    const mgr = screen.getByTestId("scim-token-manager");
    expect(mgr).toBeInTheDocument();
    expect(mgr).toHaveAttribute("data-locale", "en");
  });
});
