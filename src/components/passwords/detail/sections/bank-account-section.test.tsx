// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("../../shared/copy-button", () => ({
  CopyButton: () => <button type="button" data-testid="copy">copy</button>,
}));

import { BankAccountSection } from "./bank-account-section";
import type { InlineDetailData } from "@/types/entry";

const baseData: InlineDetailData = {
  id: "e1",
  password: "",
  url: null,
  urlHost: null,
  notes: null,
  customFields: [],
  passwordHistory: [],
  bankName: "Acme Bank",
  accountHolderName: "Alice",
  accountType: "checking",
  accountNumber: "0123456789",
  routingNumber: "012345678",
  iban: "GB00ACME01234567890",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("BankAccountSection", () => {
  it("renders bank name and holder name", () => {
    render(
      <BankAccountSection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByText("Acme Bank")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("renders the localized accountType label for known values", () => {
    render(
      <BankAccountSection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByText("accountTypeChecking")).toBeInTheDocument();
  });

  it("masks account number, routing number, and iban by default", () => {
    render(
      <BankAccountSection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.queryByText("0123456789")).not.toBeInTheDocument();
    expect(screen.queryByText("012345678")).not.toBeInTheDocument();
    expect(screen.queryByText("GB00ACME01234567890")).not.toBeInTheDocument();
    // dot mask renders multiple times
    expect(screen.getAllByText("••••••••").length).toBeGreaterThan(0);
  });
});
