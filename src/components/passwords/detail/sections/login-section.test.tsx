// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

const { copied } = vi.hoisted(() => ({ copied: [] as unknown[] }));

vi.mock("../../shared/copy-button", () => ({
  CopyButton: ({
    getValue,
    fieldLabel,
  }: {
    getValue: () => unknown;
    fieldLabel: string;
  }) => (
    <button
      type="button"
      data-testid="copy"
      aria-label={`copy ${fieldLabel}`}
      onClick={async () => {
        copied.push(await getValue());
      }}
    >
      copy
    </button>
  ),
}));

vi.mock("../../shared/favicon", () => ({
  Favicon: () => <span data-testid="favicon" />,
}));

vi.mock("../../shared/totp-field", () => ({
  TOTPField: ({
    wrapCopyGetter,
  }: {
    wrapCopyGetter: (getter: () => string) => () => Promise<string>;
  }) => (
    <button
      type="button"
      data-testid="totp"
      onClick={async () => {
        copied.push(await wrapCopyGetter(() => "123456")());
      }}
    >
      copy totp
    </button>
  ),
}));

import { LoginSection } from "./login-section";
import type { InlineDetailData } from "@/types/entry";
import type { CreateGuardedGetterFn } from "./types";

// Marks values that went through the reprompt guard so a test can tell a
// guarded copy from a plain one.
const guardedGetter: CreateGuardedGetterFn = (id, reprompt, getter) => () =>
  Promise.resolve(`guarded(${id},${String(reprompt)}):${getter()}`);
const passVerification = (_id: string, _r: boolean, cb: () => void) => cb();

function renderSection(data: Partial<InlineDetailData> = {}) {
  return render(
    <LoginSection
      data={{ ...baseData, ...data }}
      requireVerification={passVerification}
      createGuardedGetter={guardedGetter}
    />,
  );
}

const baseData: InlineDetailData = {
  id: "e1",
  requireReprompt: false,
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

  describe("copy getters", () => {
    beforeEach(() => {
      copied.length = 0;
    });

    it("copies the password through the reprompt guard", async () => {
      const user = userEvent.setup();
      renderSection({ requireReprompt: true });

      await user.click(screen.getByRole("button", { name: "copy password" }));

      await waitFor(() =>
        expect(copied).toEqual(["guarded(e1,true):secret-password"]),
      );
    });

    it("copies the URL without the reprompt guard", async () => {
      const user = userEvent.setup();
      renderSection();

      await user.click(screen.getByRole("button", { name: "copy url" }));

      await waitFor(() => expect(copied).toEqual(["https://example.com"]));
    });

    it("wraps the TOTP copy getter with the reprompt guard", async () => {
      const user = userEvent.setup();
      renderSection({ totp: { secret: "JBSWY3DPEHPK3PXP" } });

      await user.click(screen.getByTestId("totp"));

      await waitFor(() => expect(copied).toEqual(["guarded(e1,false):123456"]));
    });

    it("copies a hidden custom field through the reprompt guard", async () => {
      const user = userEvent.setup();
      renderSection({
        customFields: [{ label: "PIN", value: "4321", type: "hidden" }],
      });

      await user.click(screen.getByRole("button", { name: "copy PIN" }));

      await waitFor(() => expect(copied).toEqual(["guarded(e1,false):4321"]));
    });

    it("copies a text custom field without the reprompt guard", async () => {
      const user = userEvent.setup();
      renderSection({
        customFields: [{ label: "Account", value: "acct-1", type: "text" }],
      });

      await user.click(screen.getByRole("button", { name: "copy Account" }));

      await waitFor(() => expect(copied).toEqual(["acct-1"]));
    });

    it("copies a history password through the reprompt guard", async () => {
      const user = userEvent.setup();
      renderSection({
        passwordHistory: [{ password: "old-pw", changedAt: "2025-12-01T00:00:00Z" }],
      });

      await user.click(screen.getByRole("button", { name: /passwordHistory/ }));
      const copies = screen.getAllByRole("button", { name: "copy password" });
      await user.click(copies[copies.length - 1]);

      await waitFor(() => expect(copied).toEqual(["guarded(e1,false):old-pw"]));
    });
  });

  it("hides the password again when the toggle is clicked a second time", async () => {
    const user = userEvent.setup();
    renderSection();

    const toggle = screen.getAllByRole("button")[0];
    await user.click(toggle);
    expect(screen.getByText("autoHide")).toBeInTheDocument();
    await user.click(toggle);

    expect(screen.queryByText("secret-password")).not.toBeInTheDocument();
    expect(screen.queryByText("autoHide")).not.toBeInTheDocument();
  });

  it("does not reveal the password when verification does not pass", async () => {
    const user = userEvent.setup();
    render(
      <LoginSection
        data={baseData}
        requireVerification={() => {}}
        createGuardedGetter={guardedGetter}
      />,
    );

    await user.click(screen.getAllByRole("button")[0]);

    expect(screen.queryByText("secret-password")).not.toBeInTheDocument();
  });

  it("renders an unsafe URL as plain text instead of a link", () => {
    renderSection({ url: "javascript:alert(1)" });

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument();
  });

  it("renders a safe URL custom field as a link and an unsafe one as text", () => {
    renderSection({
      url: null,
      customFields: [
        { label: "Site", value: "https://site.example", type: "url" },
        { label: "Bad", value: "javascript:alert(1)", type: "url" },
      ],
    });

    expect(screen.getByRole("link", { name: "https://site.example" })).toHaveAttribute(
      "href",
      "https://site.example",
    );
    expect(screen.queryByRole("link", { name: "javascript:alert(1)" })).not.toBeInTheDocument();
    expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument();
  });

  it("masks a hidden custom field until its reveal toggle is clicked", async () => {
    const user = userEvent.setup();
    renderSection({
      customFields: [{ label: "PIN", value: "4321", type: "hidden" }],
    });

    expect(screen.queryByText("4321")).not.toBeInTheDocument();
    const copyPin = screen.getByRole("button", { name: "copy PIN" });
    const reveal = copyPin.previousElementSibling;
    expect(reveal).toBeInstanceOf(HTMLButtonElement);
    await user.click(reveal as HTMLButtonElement);

    expect(screen.getByText("4321")).toBeInTheDocument();
  });

  it("renders a boolean custom field as yes/no without a copy button", () => {
    renderSection({
      customFields: [
        { label: "Enabled", value: "true", type: "boolean" },
        { label: "Disabled", value: "false", type: "boolean" },
      ],
    });

    expect(screen.getByText("yes")).toBeInTheDocument();
    expect(screen.getByText("no")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "copy Enabled" })).not.toBeInTheDocument();
  });

  it("renders date and month-year custom field values", () => {
    renderSection({
      customFields: [
        { label: "Expiry", value: "2027-03-15", type: "date" },
        { label: "Card", value: "2028-04", type: "monthYear" },
        { label: "EmptyDate", value: "", type: "date" },
      ],
    });

    expect(screen.queryByText("2027-03-15")).not.toBeInTheDocument();
    expect(screen.getByText(/2027/)).toBeInTheDocument();
    expect(screen.getByText("2028-04")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "copy EmptyDate" })).toBeInTheDocument();
  });

  it("expands the password history and reveals one entry at a time", async () => {
    const user = userEvent.setup();
    renderSection({
      passwordHistory: [
        { password: "old-1", changedAt: "2025-12-01T00:00:00Z" },
        { password: "old-2", changedAt: "2025-11-01T00:00:00Z" },
      ],
    });

    const header = screen.getByRole("button", { name: /passwordHistory \(2\)/ });
    expect(screen.queryAllByText("••••••••••••")).toHaveLength(1);
    await user.click(header);
    expect(screen.getAllByText("••••••••••••")).toHaveLength(3);

    const firstCopy = screen.getAllByRole("button", { name: "copy password" })[1];
    await user.click(firstCopy.previousElementSibling as HTMLButtonElement);

    expect(screen.getByText("old-1")).toBeInTheDocument();
    expect(screen.queryByText("old-2")).not.toBeInTheDocument();

    await user.click(header);
    expect(screen.queryByText("old-1")).not.toBeInTheDocument();
  });
});
