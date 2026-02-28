import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import {
  handleTeamCardNumberChange,
  submitTeamPasswordForm,
} from "@/components/team/team-password-form-actions";

const executeTeamEntrySubmitMock = vi.fn();

vi.mock("@/components/team/team-entry-submit", () => ({
  executeTeamEntrySubmit: (...args: unknown[]) => executeTeamEntrySubmitMock(...args),
}));

describe("team-password-form-actions", () => {
  beforeEach(() => {
    executeTeamEntrySubmitMock.mockReset();
  });

  it("updates brand automatically when brand source is auto", () => {
    const setCardNumber = vi.fn();
    const setBrand = vi.fn();

    handleTeamCardNumberChange({
      value: "4242424242424242",
      brand: "",
      brandSource: "auto",
      setCardNumber,
      setBrand,
    });

    expect(setCardNumber).toHaveBeenCalled();
    expect(setBrand).toHaveBeenCalledWith("Visa");
  });

  it("does not overwrite brand when brand source is manual", () => {
    const setCardNumber = vi.fn();
    const setBrand = vi.fn();

    handleTeamCardNumberChange({
      value: "4242424242424242",
      brand: "mastercard",
      brandSource: "manual",
      setCardNumber,
      setBrand,
    });

    expect(setCardNumber).toHaveBeenCalled();
    expect(setBrand).not.toHaveBeenCalled();
  });

  it("stops submit when validation fails and sets identity errors", async () => {
    const setDobError = vi.fn();
    const setExpiryError = vi.fn();

    await submitTeamPasswordForm({
      teamId: "team-1",
      isEdit: false,
      effectiveEntryType: ENTRY_TYPE.IDENTITY,
      title: "id",
      notes: "",
      selectedTags: [],
      teamFolderId: null,
      username: "",
      password: "",
      url: "",
      customFields: [],
      totp: null,
      content: "",
      cardholderName: "",
      cardNumber: "",
      brand: "",
      expiryMonth: "",
      expiryYear: "",
      cvv: "",
      fullName: "",
      address: "",
      phone: "",
      email: "",
      dateOfBirth: "2999-01-01",
      nationality: "",
      idNumber: "",
      issueDate: "2030-01-01",
      expiryDate: "2020-01-01",
      relyingPartyId: "",
      relyingPartyName: "",
      credentialId: "",
      creationDate: "",
      deviceInfo: "",
      bankName: "",
      accountType: "",
      accountHolderName: "",
      accountNumber: "",
      routingNumber: "",
      swiftBic: "",
      iban: "",
      branchName: "",
      softwareName: "",
      licenseKey: "",
      version: "",
      licensee: "",
      purchaseDate: "",
      expirationDate: "",
      cardNumberValid: true,
      isIdentity: true,
      isBankAccount: false,
      isSoftwareLicense: false,
      setDobError,
      setExpiryError,
      identityErrorCopy: {
        dobFuture: "dob future",
        expiryBeforeIssue: "expiry before issue",
      },
      softwareLicenseErrorCopy: {
        expirationBeforePurchase: "expiration before purchase",
      },
      t: (key) => key,
      setSaving: vi.fn(),
      handleOpenChange: vi.fn(),
      onSaved: vi.fn(),
    });

    expect(setDobError).toHaveBeenCalledWith("dob future");
    expect(setExpiryError).toHaveBeenCalledWith("expiry before issue");
    expect(executeTeamEntrySubmitMock).not.toHaveBeenCalled();
  });
});
