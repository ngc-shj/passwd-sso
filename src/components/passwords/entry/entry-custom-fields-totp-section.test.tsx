// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/passwords/shared/totp-field", () => ({
  TOTPField: ({
    onRemove,
  }: {
    onRemove?: () => void;
  }) => (
    <div data-testid="totp-field">
      <button type="button" onClick={onRemove}>
        remove-totp
      </button>
    </div>
  ),
}));

import { EntryCustomFieldsTotpSection } from "./entry-custom-fields-totp-section";

describe("EntryCustomFieldsTotpSection", () => {
  it("renders an Add Field button", () => {
    render(
      <EntryCustomFieldsTotpSection
        customFields={[]}
        setCustomFields={vi.fn()}
        totp={null}
        onTotpChange={vi.fn()}
        showTotpInput={false}
        setShowTotpInput={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /addField/i }),
    ).toBeInTheDocument();
  });

  it("invokes setCustomFields appender when Add Field is clicked", async () => {
    const setCustomFields = vi.fn();
    const user = userEvent.setup();

    render(
      <EntryCustomFieldsTotpSection
        customFields={[]}
        setCustomFields={setCustomFields}
        totp={null}
        onTotpChange={vi.fn()}
        showTotpInput={false}
        setShowTotpInput={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /addField/i }));

    expect(setCustomFields).toHaveBeenCalled();
    const updater = setCustomFields.mock.calls[0][0] as (
      prev: { label: string; value: string; type: string }[],
    ) => unknown;
    expect(updater([])).toEqual([
      expect.objectContaining({ label: "", value: "" }),
    ]);
  });

  it("renders TOTP input when showTotpInput is true", () => {
    render(
      <EntryCustomFieldsTotpSection
        customFields={[]}
        setCustomFields={vi.fn()}
        totp={null}
        onTotpChange={vi.fn()}
        showTotpInput={true}
        setShowTotpInput={vi.fn()}
      />,
    );

    expect(screen.getByTestId("totp-field")).toBeInTheDocument();
  });

  it("calls setShowTotpInput(true) when Add TOTP is clicked", async () => {
    const setShowTotpInput = vi.fn();
    const user = userEvent.setup();

    render(
      <EntryCustomFieldsTotpSection
        customFields={[]}
        setCustomFields={vi.fn()}
        totp={null}
        onTotpChange={vi.fn()}
        showTotpInput={false}
        setShowTotpInput={setShowTotpInput}
      />,
    );

    await user.click(screen.getByRole("button", { name: /addTotp/i }));

    expect(setShowTotpInput).toHaveBeenCalledWith(true);
  });
});
