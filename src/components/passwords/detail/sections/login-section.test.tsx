// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("../../shared/copy-button", () => ({
  CopyButton: ({ getValue: _getValue }: { getValue: () => unknown }) => (
    <button type="button" data-testid="copy">
      copy
    </button>
  ),
}));

vi.mock("../../shared/favicon", () => ({
  Favicon: () => <span data-testid="favicon" />,
}));

vi.mock("../../shared/totp-field", () => ({
  TOTPField: () => <div data-testid="totp" />,
}));

import { LoginSection } from "./login-section";
import type { InlineDetailData } from "@/types/entry";

const baseData: InlineDetailData = {
  id: "e1",
  password: "secret-password",
  url: "https://example.com",
  urlHost: "example.com",
  notes: "my notes",
  customFields: [],
  passwordHistory: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("LoginSection", () => {
  it("renders the password masked by default", () => {
    render(
      <LoginSection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByText("••••••••••••")).toBeInTheDocument();
    expect(screen.queryByText("secret-password")).not.toBeInTheDocument();
  });

  it("reveals the password when reveal toggle is clicked", async () => {
    const user = userEvent.setup();
    render(
      <LoginSection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    // Find the eye toggle button — it's the first ghost icon button next to the password
    const buttons = screen.getAllByRole("button");
    // Eye toggle is the first non-copy button
    const toggle = buttons.find((b) => b.getAttribute("data-testid") !== "copy");
    expect(toggle).toBeDefined();
    await user.click(toggle as HTMLButtonElement);

    expect(screen.getByText("secret-password")).toBeInTheDocument();
  });

  it("renders URL and notes when present", () => {
    render(
      <LoginSection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(
      screen.getByRole("link", { name: "https://example.com" }),
    ).toBeInTheDocument();
    expect(screen.getByText("my notes")).toBeInTheDocument();
  });

  it("does not render URL section when url is null", () => {
    render(
      <LoginSection
        data={{ ...baseData, url: null, notes: null }}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
