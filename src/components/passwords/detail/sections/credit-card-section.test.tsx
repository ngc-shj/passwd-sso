// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const { copied } = vi.hoisted(() => ({ copied: [] as unknown[] }));

vi.mock("../../shared/copy-button", () => ({
  CopyButton: ({ getValue, fieldLabel }: { getValue: () => unknown; fieldLabel: string }) => (
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

import { CreditCardSection } from "./credit-card-section";
import { formatCardNumber } from "@/lib/ui/credit-card";
import type { InlineDetailData } from "@/types/entry";
import type { CreateGuardedGetterFn } from "./types";

const baseData: InlineDetailData = {
  id: "e1",
  requireReprompt: false,
  password: "",
  url: null,
  urlHost: null,
  notes: null,
  customFields: [],
  passwordHistory: [],
  cardNumber: "4111111111111111",
  cardholderName: "Alice",
  brand: "Visa",
  expiryMonth: "12",
  expiryYear: "2030",
  cvv: "123",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("CreditCardSection", () => {
  it("renders cardholder name and brand", () => {
    render(
      <CreditCardSection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Visa")).toBeInTheDocument();
  });

  it("masks the card number except for last 4 by default", () => {
    render(
      <CreditCardSection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByText("•••• •••• •••• 1111")).toBeInTheDocument();
    expect(screen.queryByText(/4111111111111111/)).not.toBeInTheDocument();
  });

  it("reveals full card number when reveal toggle is clicked", async () => {
    const user = userEvent.setup();
    render(
      <CreditCardSection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    // Click first reveal toggle (card number reveal)
    const buttons = screen.getAllByRole("button");
    const reveal = buttons.find((b) => b.getAttribute("data-testid") !== "copy");
    expect(reveal).toBeDefined();
    await user.click(reveal as HTMLButtonElement);

    // formatCardNumber may add spaces; assert digits present
    expect(screen.getByText(/4111/)).toBeInTheDocument();
  });
});

// Marks values that went through the reprompt guard so a test can tell a
// guarded copy from a plain one.
const guardedGetter: CreateGuardedGetterFn = (id, reprompt, getter) => () =>
  Promise.resolve(`guarded(${id},${String(reprompt)}):${getter()}`);
const passVerification = (_id: string, _r: boolean, cb: () => void) => cb();
const denyVerification = () => {};

const fullData: InlineDetailData = {
  ...baseData,
  notes: "card memo",
};

function renderFull(
  data: InlineDetailData = fullData,
  requireVerification: (id: string, r: boolean, cb: () => void) => void = passVerification,
) {
  return render(
    <CreditCardSection
      data={data}
      requireVerification={requireVerification}
      createGuardedGetter={guardedGetter}
    />,
  );
}

// The reveal toggle is the icon button in the same field as the label.
function revealToggle(label: string): HTMLElement {
  const field = screen.getByText(label).closest("div");
  if (!field) throw new Error(`no field for ${label}`);
  const toggle = within(field)
    .getAllByRole("button")
    .find((b) => b.dataset.testid !== "copy");
  if (!toggle) throw new Error(`no reveal toggle for ${label}`);
  return toggle;
}

describe("CreditCardSection copy and reveal", () => {
  beforeEach(() => {
    copied.length = 0;
  });

  it.each([
    ["cardholderName", "Alice"],
  ])("copies %s as plain text without the reprompt guard", async (label, value) => {
    renderFull({ ...fullData, requireReprompt: true });
    fireEvent.click(screen.getByRole("button", { name: `copy ${label}` }));
    await waitFor(() => expect(copied).toEqual([value]));
  });

  it.each([
    ["cardNumber", "4111111111111111"],
    ["cvv", "123"],
  ])("copies %s through the reprompt guard", async (label, value) => {
    renderFull({ ...fullData, requireReprompt: true });
    fireEvent.click(screen.getByRole("button", { name: `copy ${label}` }));
    await waitFor(() => expect(copied).toEqual([`guarded(e1,true):${value}`]));
  });

  it.each([
    ["cardNumber", formatCardNumber("4111111111111111", "Visa")],
    ["cvv", "123"],
  ])("reveals %s with an auto-hide notice and masks it again on the second click", (label, shown) => {
    renderFull();
    fireEvent.click(revealToggle(label));
    expect(screen.getByText(shown)).toBeInTheDocument();
    expect(screen.getByText("autoHide")).toBeInTheDocument();

    fireEvent.click(revealToggle(label));
    expect(screen.queryByText(shown)).not.toBeInTheDocument();
    expect(screen.queryByText("autoHide")).not.toBeInTheDocument();
  });

  it("keeps cvv masked when verification is not granted", () => {
    renderFull(fullData, denyVerification);
    fireEvent.click(revealToggle("cvv"));
    expect(screen.queryByText("123")).not.toBeInTheDocument();
    expect(screen.queryByText("autoHide")).not.toBeInTheDocument();
  });

  it("shows placeholders for a missing expiry month", () => {
    renderFull({ ...fullData, expiryMonth: null });
    expect(screen.getByText("--/2030")).toBeInTheDocument();
  });

  it("shows placeholders for a missing expiry year", () => {
    renderFull({ ...fullData, expiryYear: null });
    expect(screen.getByText("12/----")).toBeInTheDocument();
  });

  it("renders the notes", () => {
    renderFull();
    expect(screen.getByText("card memo")).toBeInTheDocument();
  });
});
