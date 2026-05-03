// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("../../shared/copy-button", () => ({
  CopyButton: () => <button type="button" data-testid="copy">copy</button>,
}));

import { CreditCardSection } from "./credit-card-section";
import type { InlineDetailData } from "@/types/entry";

const baseData: InlineDetailData = {
  id: "e1",
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
