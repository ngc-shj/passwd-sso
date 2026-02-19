import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import {
  handleOrgCardNumberChange,
  submitOrgPasswordForm,
} from "@/components/org/org-password-form-actions";

const executeOrgEntrySubmitMock = vi.fn();

vi.mock("@/components/org/org-entry-submit", () => ({
  executeOrgEntrySubmit: (...args: unknown[]) => executeOrgEntrySubmitMock(...args),
}));

describe("org-password-form-actions", () => {
  beforeEach(() => {
    executeOrgEntrySubmitMock.mockReset();
  });

  it("updates brand automatically when brand source is auto", () => {
    const setCardNumber = vi.fn();
    const setBrand = vi.fn();

    handleOrgCardNumberChange({
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

    handleOrgCardNumberChange({
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

    await submitOrgPasswordForm({
      orgId: "org-1",
      isEdit: false,
      effectiveEntryType: ENTRY_TYPE.IDENTITY,
      title: "id",
      notes: "",
      selectedTags: [],
      orgFolderId: null,
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
      cardNumberValid: true,
      isIdentity: true,
      setDobError,
      setExpiryError,
      identityErrorCopy: {
        dobFuture: "dob future",
        expiryBeforeIssue: "expiry before issue",
      },
      t: (key) => key,
      setSaving: vi.fn(),
      handleOpenChange: vi.fn(),
      onSaved: vi.fn(),
    });

    expect(setDobError).toHaveBeenCalledWith("dob future");
    expect(setExpiryError).toHaveBeenCalledWith("expiry before issue");
    expect(executeOrgEntrySubmitMock).not.toHaveBeenCalled();
  });
});
