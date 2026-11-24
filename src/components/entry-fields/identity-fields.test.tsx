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
  givenName: "",
  onGivenNameChange: vi.fn(),
  givenNamePlaceholder: "GivenPH",
  familyName: "",
  onFamilyNameChange: vi.fn(),
  familyNamePlaceholder: "FamilyPH",
  middleName: "",
  onMiddleNameChange: vi.fn(),
  middleNamePlaceholder: "MiddlePH",
  familyNameKana: "",
  onFamilyNameKanaChange: vi.fn(),
  familyNameKanaPlaceholder: "FamilyKanaPH",
  givenNameKana: "",
  onGivenNameKanaChange: vi.fn(),
  givenNameKanaPlaceholder: "GivenKanaPH",
  addressLine1: "",
  onAddressLine1Change: vi.fn(),
  addressLine1Placeholder: "Addr1PH",
  addressLine2: "",
  onAddressLine2Change: vi.fn(),
  addressLine2Placeholder: "Addr2PH",
  city: "",
  onCityChange: vi.fn(),
  cityPlaceholder: "CityPH",
  state: "",
  onStateChange: vi.fn(),
  statePlaceholder: "StatePH",
  postalCode: "",
  onPostalCodeChange: vi.fn(),
  postalCodePlaceholder: "PostalPH",
  country: "",
  onCountryChange: vi.fn(),
  countryPlaceholder: "CountryPH",
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
    givenName: "Given name",
    familyName: "Family name",
    middleName: "Middle name",
    familyNameKana: "Family kana",
    givenNameKana: "Given kana",
    addressLine1: "Address line 1",
    addressLine2: "Address line 2",
    city: "City",
    state: "State",
    postalCode: "Postal code",
    country: "Country",
    nameGroup: "Name",
    addressGroup: "Address group",
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

  const fieldHandlers = [
    ["Family name", "onFamilyNameChange", "Yamada"],
    ["Given name", "onGivenNameChange", "Taro"],
    ["Middle name", "onMiddleNameChange", "Q"],
    ["Family kana", "onFamilyNameKanaChange", "ヤマダ"],
    ["Given kana", "onGivenNameKanaChange", "タロウ"],
    ["Full name", "onFullNameChange", "Taro Yamada"],
    ["Address line 1", "onAddressLine1Change", "1-2-3 Chiyoda"],
    ["Address line 2", "onAddressLine2Change", "Room 4"],
    ["City", "onCityChange", "Tokyo"],
    ["State", "onStateChange", "Tokyo-to"],
    ["Postal code", "onPostalCodeChange", "100-0001"],
    ["Country", "onCountryChange", "Japan"],
    ["Address", "onAddressChange", "combined address"],
    ["Email", "onEmailChange", "taro@example.com"],
    ["DOB", "onDateOfBirthChange", "1990-01-02"],
    ["Nationality", "onNationalityChange", "JP"],
    ["ID number", "onIdNumberChange", "AB1234567"],
    ["Issue", "onIssueDateChange", "2020-01-01"],
    ["Expiry", "onExpiryDateChange", "2030-01-01"],
  ] as const;

  it.each(fieldHandlers)("routes a change in the %s field to %s only", (label, handler, value) => {
    const handlers = Object.fromEntries(fieldHandlers.map(([, name]) => [name, vi.fn()]));
    render(<IdentityFields {...baseProps} {...handlers} />);
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    expect(handlers[handler]).toHaveBeenCalledWith(value);
    for (const [name, fn] of Object.entries(handlers)) {
      if (name !== handler) expect(fn).not.toHaveBeenCalled();
    }
  });

  it("masks the ID number until showIdNumber is set", () => {
    const { rerender } = render(<IdentityFields {...baseProps} idNumber="X1" />);
    expect(screen.getByLabelText("ID number")).toHaveAttribute("type", "password");
    rerender(<IdentityFields {...baseProps} idNumber="X1" showIdNumber />);
    expect(screen.getByLabelText("ID number")).toHaveAttribute("type", "text");
  });
});
