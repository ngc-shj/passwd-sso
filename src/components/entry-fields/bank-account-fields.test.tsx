// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ENTRY_NAME_MAX, ENTRY_SHORT_MAX, SWIFT_BIC_MAX } from "@/lib/validations";
import { BankAccountFields } from "./bank-account-fields";

const baseProps = {
  bankName: "",
  onBankNameChange: vi.fn(),
  bankNamePlaceholder: "BankPH",
  accountType: "checking",
  onAccountTypeChange: vi.fn(),
  accountTypePlaceholder: "TypePH",
  accountTypeCheckingLabel: "Checking",
  accountTypeSavingsLabel: "Savings",
  accountTypeOtherLabel: "Other",
  accountHolderName: "",
  onAccountHolderNameChange: vi.fn(),
  accountHolderNamePlaceholder: "HolderPH",
  accountNumber: "",
  onAccountNumberChange: vi.fn(),
  accountNumberPlaceholder: "AcctPH",
  showAccountNumber: false,
  onToggleAccountNumber: vi.fn(),
  routingNumber: "",
  onRoutingNumberChange: vi.fn(),
  routingNumberPlaceholder: "RoutePH",
  showRoutingNumber: false,
  onToggleRoutingNumber: vi.fn(),
  swiftBic: "",
  onSwiftBicChange: vi.fn(),
  swiftBicPlaceholder: "SwiftPH",
  iban: "",
  onIbanChange: vi.fn(),
  ibanPlaceholder: "IbanPH",
  branchName: "",
  onBranchNameChange: vi.fn(),
  branchNamePlaceholder: "BranchPH",
  notesLabel: "Notes",
  notes: "",
  onNotesChange: vi.fn(),
  notesPlaceholder: "NotesPH",
  labels: {
    bankName: "Bank name",
    accountType: "Type",
    accountHolderName: "Holder",
    accountNumber: "Account number",
    routingNumber: "Routing",
    swiftBic: "SWIFT/BIC",
    iban: "IBAN",
    branchName: "Branch",
  },
};

describe("BankAccountFields", () => {
  it("renders all field labels", () => {
    render(<BankAccountFields {...baseProps} />);
    expect(screen.getByText("Bank name")).toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
    expect(screen.getByText("Holder")).toBeInTheDocument();
    expect(screen.getByText("Account number")).toBeInTheDocument();
    expect(screen.getByText("Routing")).toBeInTheDocument();
    expect(screen.getByText("SWIFT/BIC")).toBeInTheDocument();
    expect(screen.getByText("IBAN")).toBeInTheDocument();
    expect(screen.getByText("Branch")).toBeInTheDocument();
  });

  it("propagates change to onBankNameChange when typing in the bank-name input", () => {
    const onBankNameChange = vi.fn();
    render(<BankAccountFields {...baseProps} onBankNameChange={onBankNameChange} />);
    fireEvent.change(screen.getByPlaceholderText("BankPH"), { target: { value: "ACME Bank" } });
    expect(onBankNameChange).toHaveBeenCalledWith("ACME Bank");
  });

  it("applies maxLength constants from @/lib/validations to inputs (RT3)", () => {
    render(<BankAccountFields {...baseProps} />);
    expect(screen.getByPlaceholderText("BankPH")).toHaveAttribute(
      "maxLength",
      String(ENTRY_NAME_MAX),
    );
    expect(screen.getByPlaceholderText("AcctPH")).toHaveAttribute(
      "maxLength",
      String(ENTRY_SHORT_MAX),
    );
    expect(screen.getByPlaceholderText("SwiftPH")).toHaveAttribute(
      "maxLength",
      String(SWIFT_BIC_MAX),
    );
  });

  it("idPrefix flows into input ids", () => {
    render(<BankAccountFields {...baseProps} idPrefix="edit-" />);
    expect(screen.getByPlaceholderText("BankPH").id).toBe("edit-bankName");
  });

  it.each([
    ["HolderPH", "onAccountHolderNameChange", "Jane Doe"],
    ["AcctPH", "onAccountNumberChange", "123456789"],
    ["RoutePH", "onRoutingNumberChange", "021000021"],
    ["BranchPH", "onBranchNameChange", "Main St"],
    ["SwiftPH", "onSwiftBicChange", "DEUTDEFF"],
    ["IbanPH", "onIbanChange", "DE89370400440532013000"],
    ["NotesPH", "onNotesChange", "memo"],
  ] as const)("routes typing in the %s input to %s only", (placeholder, handler, value) => {
    const handlers = {
      onAccountHolderNameChange: vi.fn(),
      onAccountNumberChange: vi.fn(),
      onRoutingNumberChange: vi.fn(),
      onBranchNameChange: vi.fn(),
      onSwiftBicChange: vi.fn(),
      onIbanChange: vi.fn(),
      onNotesChange: vi.fn(),
    };
    render(<BankAccountFields {...baseProps} {...handlers} />);
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
    expect(handlers[handler]).toHaveBeenCalledWith(value);
    for (const [name, fn] of Object.entries(handlers)) {
      if (name !== handler) expect(fn).not.toHaveBeenCalled();
    }
  });

  it("masks the account and routing numbers until their toggles are shown", () => {
    const { rerender } = render(
      <BankAccountFields {...baseProps} accountNumber="111" routingNumber="222" />,
    );
    expect(screen.getByPlaceholderText("AcctPH")).toHaveAttribute("type", "password");
    expect(screen.getByPlaceholderText("RoutePH")).toHaveAttribute("type", "password");

    rerender(
      <BankAccountFields
        {...baseProps}
        accountNumber="111"
        routingNumber="222"
        showAccountNumber
        showRoutingNumber
      />,
    );
    expect(screen.getByPlaceholderText("AcctPH")).toHaveAttribute("type", "text");
    expect(screen.getByPlaceholderText("RoutePH")).toHaveAttribute("type", "text");
  });
});
