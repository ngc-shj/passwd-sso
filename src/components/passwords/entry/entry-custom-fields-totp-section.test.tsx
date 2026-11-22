// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";

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

// Radix Select does not open in jsdom; render each item as a button that
// fires the Select's onValueChange with the item's value.
vi.mock("@/components/ui/select", async () => {
  const { createContext, useContext } = await import("react");
  const Ctx = createContext<((v: string) => void) | undefined>(undefined);
  return {
    Select: ({
      children,
      onValueChange,
    }: {
      children: ReactNode;
      onValueChange?: (v: string) => void;
    }) => <Ctx.Provider value={onValueChange}>{children}</Ctx.Provider>,
    SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: function SelectItem({
      children,
      value,
    }: {
      children: ReactNode;
      value: string;
    }) {
      const onValueChange = useContext(Ctx);
      return (
        <button type="button" onClick={() => onValueChange?.(value)}>
          {children}
        </button>
      );
    },
  };
});

import { EntryCustomFieldsTotpSection } from "./entry-custom-fields-totp-section";
import type { EntryCustomField } from "@/lib/vault/entry-form-types";

function Harness({ initial }: { initial: EntryCustomField[] }) {
  const [fields, setFields] = useState<EntryCustomField[]>(initial);
  return (
    <>
      <EntryCustomFieldsTotpSection
        customFields={fields}
        setCustomFields={setFields}
        totp={null}
        onTotpChange={vi.fn()}
        showTotpInput={false}
        setShowTotpInput={vi.fn()}
      />
      <output data-testid="state">{JSON.stringify(fields)}</output>
    </>
  );
}

function fieldsState(): EntryCustomField[] {
  return JSON.parse(screen.getByTestId("state").textContent ?? "[]") as EntryCustomField[];
}

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

  it("calls setShowTotpInput(false) when the TOTP field is removed", async () => {
    const setShowTotpInput = vi.fn();
    const user = userEvent.setup();

    render(
      <EntryCustomFieldsTotpSection
        customFields={[]}
        setCustomFields={vi.fn()}
        totp={null}
        onTotpChange={vi.fn()}
        showTotpInput={true}
        setShowTotpInput={setShowTotpInput}
      />,
    );

    expect(screen.queryByRole("button", { name: /addTotp/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "remove-totp" }));

    expect(setShowTotpInput).toHaveBeenCalledWith(false);
  });

  it("updates only the edited field's label", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[
          { label: "a", value: "1", type: "text" },
          { label: "b", value: "2", type: "text" },
        ]}
      />,
    );

    const labels = screen.getAllByPlaceholderText("fieldLabel");
    await user.type(labels[1], "x");

    expect(fieldsState()).toEqual([
      { label: "a", value: "1", type: "text" },
      { label: "bx", value: "2", type: "text" },
    ]);
  });

  it("updates only the edited field's value", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[
          { label: "a", value: "1", type: "text" },
          { label: "b", value: "2", type: "text" },
        ]}
      />,
    );

    await user.type(screen.getAllByPlaceholderText("fieldValue")[0], "9");

    expect(fieldsState()).toEqual([
      { label: "a", value: "19", type: "text" },
      { label: "b", value: "2", type: "text" },
    ]);
  });

  it("removes the field whose delete button is clicked", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Harness
        initial={[
          { label: "a", value: "1", type: "text" },
          { label: "b", value: "2", type: "text" },
        ]}
      />,
    );

    const rows = container.querySelectorAll<HTMLElement>(".rounded-lg.border");
    const rowButtons = within(rows[0]).getAllByRole("button");
    await user.click(rowButtons[rowButtons.length - 1]);

    expect(fieldsState()).toEqual([{ label: "b", value: "2", type: "text" }]);
  });

  it("resets the value to \"false\" when the type changes to boolean", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ label: "a", value: "keep", type: "text" }]} />);

    await user.click(screen.getByRole("button", { name: "fieldBoolean" }));

    expect(fieldsState()).toEqual([{ label: "a", value: "false", type: "boolean" }]);
    expect(screen.getByRole("switch")).not.toBeChecked();
    expect(screen.getByText("booleanFalse")).toBeInTheDocument();
  });

  it.each([
    ["fieldDate", "date"],
    ["fieldMonthYear", "monthYear"],
  ])("clears the value when the type changes via %s", async (itemLabel, type) => {
    const user = userEvent.setup();
    render(<Harness initial={[{ label: "a", value: "keep", type: "text" }]} />);

    await user.click(screen.getByRole("button", { name: itemLabel }));

    expect(fieldsState()).toEqual([{ label: "a", value: "", type }]);
  });

  it("keeps the value when the type changes to hidden", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ label: "a", value: "keep", type: "text" }]} />);

    await user.click(screen.getByRole("button", { name: "fieldHidden" }));

    expect(fieldsState()).toEqual([{ label: "a", value: "keep", type: "hidden" }]);
    expect(screen.getByPlaceholderText("fieldValue")).toHaveAttribute("type", "password");
  });

  it.each([
    ["url", "url"],
    ["date", "date"],
    ["monthYear", "month"],
    ["text", "text"],
  ] as const)("renders a %s field value as an input of type %s", (type, inputType) => {
    render(<Harness initial={[{ label: "a", value: "", type }]} />);

    expect(screen.getByPlaceholderText("fieldValue")).toHaveAttribute("type", inputType);
  });

  it("toggles a boolean field's value with the switch", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ label: "a", value: "false", type: "boolean" }]} />);

    await user.click(screen.getByRole("switch"));

    expect(fieldsState()).toEqual([{ label: "a", value: "true", type: "boolean" }]);
    expect(screen.getByText("booleanTrue")).toBeInTheDocument();
  });
});
