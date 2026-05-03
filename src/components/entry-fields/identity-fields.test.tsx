// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { IdentityFields } from "./identity-fields";

const baseProps = {
  fullName: "",
  onFullNameChange: vi.fn(),
  fullNamePlaceholder: "FullPH",
  address: "",
  onAddressChange: vi.fn(),
  addressPlaceholder: "AddrPH",
  phone: "",
  onPhoneChange: vi.fn(),
  phonePlaceholder: "PhonePH",
  email: "",
  onEmailChange: vi.fn(),
  emailPlaceholder: "EmailPH",
  dateOfBirth: "",
  onDateOfBirthChange: vi.fn(),
  nationality: "",
  onNationalityChange: vi.fn(),
  nationalityPlaceholder: "NatPH",
  idNumber: "",
  onIdNumberChange: vi.fn(),
  idNumberPlaceholder: "IdPH",
  showIdNumber: false,
  onToggleIdNumber: vi.fn(),
  issueDate: "",
  onIssueDateChange: vi.fn(),
  expiryDate: "",
  onExpiryDateChange: vi.fn(),
  dobError: null as string | null,
  expiryError: null as string | null,
  notesLabel: "Notes",
  notes: "",
  onNotesChange: vi.fn(),
  notesPlaceholder: "NotesPH",
  labels: {
    fullName: "Full name",
    address: "Address",
    phone: "Phone",
    email: "Email",
    dateOfBirth: "DOB",
    nationality: "Nationality",
    idNumber: "ID number",
    issueDate: "Issue",
    expiryDate: "Expiry",
  },
};

describe("IdentityFields", () => {
  it("renders all field labels", () => {
    render(<IdentityFields {...baseProps} />);
    expect(screen.getByText("Full name")).toBeInTheDocument();
    expect(screen.getByText("Address")).toBeInTheDocument();
    expect(screen.getByText("ID number")).toBeInTheDocument();
  });

  it("does not render dobError or expiryError when null", () => {
    render(<IdentityFields {...baseProps} />);
    expect(screen.queryByRole("paragraph")).toBeNull();
  });

  it("renders dobError when provided", () => {
    render(<IdentityFields {...baseProps} dobError="DOB invalid" />);
    expect(screen.getByText("DOB invalid")).toBeInTheDocument();
  });

  it("renders expiryError when provided", () => {
    render(<IdentityFields {...baseProps} expiryError="Expiry invalid" />);
    expect(screen.getByText("Expiry invalid")).toBeInTheDocument();
  });

  it("propagates onPhoneChange", () => {
    const onPhoneChange = vi.fn();
    render(<IdentityFields {...baseProps} onPhoneChange={onPhoneChange} />);
    fireEvent.change(screen.getByPlaceholderText("PhonePH"), { target: { value: "555-1234" } });
    expect(onPhoneChange).toHaveBeenCalledWith("555-1234");
  });
});
