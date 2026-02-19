import { describe, expect, it, vi } from "vitest";
import { buildOrgEntrySpecificCallbacks } from "@/hooks/org-entry-specific-fields-callbacks";
import type {
  OrgPasswordFormSettersState,
  OrgPasswordFormValues,
} from "@/hooks/use-org-password-form-state";

function createState(): {
  values: OrgPasswordFormValues;
  setters: OrgPasswordFormSettersState;
} {
  return {
    values: {
      saving: false,
      showPassword: true,
      showGenerator: true,
      showCardNumber: true,
      showCvv: true,
      showIdNumber: true,
      showCredentialId: true,
      title: "",
      username: "",
      password: "",
      content: "",
      url: "",
      notes: "",
      selectedTags: [],
      generatorSettings: {} as OrgPasswordFormValues["generatorSettings"],
      customFields: [],
      totp: null,
      showTotpInput: false,
      cardholderName: "",
      cardNumber: "",
      brand: "",
      brandSource: "auto",
      expiryMonth: "",
      expiryYear: "",
      cvv: "",
      fullName: "",
      address: "",
      phone: "",
      email: "",
      dateOfBirth: "",
      nationality: "",
      idNumber: "",
      issueDate: "",
      expiryDate: "",
      dobError: null,
      expiryError: null,
      relyingPartyId: "",
      relyingPartyName: "",
      credentialId: "",
      creationDate: "",
      deviceInfo: "",
      orgFolderId: null,
    },
    setters: {
      setSaving: vi.fn(),
      setShowPassword: vi.fn(),
      setShowGenerator: vi.fn(),
      setShowCardNumber: vi.fn(),
      setShowCvv: vi.fn(),
      setShowIdNumber: vi.fn(),
      setShowCredentialId: vi.fn(),
      setTitle: vi.fn(),
      setUsername: vi.fn(),
      setPassword: vi.fn(),
      setContent: vi.fn(),
      setUrl: vi.fn(),
      setNotes: vi.fn(),
      setSelectedTags: vi.fn(),
      setGeneratorSettings: vi.fn(),
      setCustomFields: vi.fn(),
      setTotp: vi.fn(),
      setShowTotpInput: vi.fn(),
      setCardholderName: vi.fn(),
      setCardNumber: vi.fn(),
      setBrand: vi.fn(),
      setBrandSource: vi.fn(),
      setExpiryMonth: vi.fn(),
      setExpiryYear: vi.fn(),
      setCvv: vi.fn(),
      setFullName: vi.fn(),
      setAddress: vi.fn(),
      setPhone: vi.fn(),
      setEmail: vi.fn(),
      setDateOfBirth: vi.fn(),
      setNationality: vi.fn(),
      setIdNumber: vi.fn(),
      setIssueDate: vi.fn(),
      setExpiryDate: vi.fn(),
      setDobError: vi.fn(),
      setExpiryError: vi.fn(),
      setRelyingPartyId: vi.fn(),
      setRelyingPartyName: vi.fn(),
      setCredentialId: vi.fn(),
      setCreationDate: vi.fn(),
      setDeviceInfo: vi.fn(),
      setOrgFolderId: vi.fn(),
    },
  };
}

describe("buildOrgEntrySpecificCallbacks", () => {
  it("toggles visibility flags and applies generated password", () => {
    const { values, setters } = createState();
    const callbacks = buildOrgEntrySpecificCallbacks(values, setters);

    callbacks.onToggleShowPassword();
    callbacks.onToggleGenerator();
    callbacks.onToggleCardNumber();
    callbacks.onToggleCvv();
    callbacks.onToggleIdNumber();
    callbacks.onToggleCredentialId();

    expect(setters.setShowPassword).toHaveBeenCalledWith(false);
    expect(setters.setShowGenerator).toHaveBeenCalledWith(false);
    expect(setters.setShowCardNumber).toHaveBeenCalledWith(false);
    expect(setters.setShowCvv).toHaveBeenCalledWith(false);
    expect(setters.setShowIdNumber).toHaveBeenCalledWith(false);
    expect(setters.setShowCredentialId).toHaveBeenCalledWith(false);

    const settings = { length: 20 } as OrgPasswordFormValues["generatorSettings"];
    callbacks.onGeneratorUse("generated", settings);
    expect(setters.setPassword).toHaveBeenCalledWith("generated");
    expect(setters.setShowPassword).toHaveBeenCalledWith(true);
    expect(setters.setGeneratorSettings).toHaveBeenCalledWith(settings);
  });

  it("sets manual brand source and clears identity date errors", () => {
    const { values, setters } = createState();
    const callbacks = buildOrgEntrySpecificCallbacks(values, setters);

    callbacks.onBrandChange("Visa");
    expect(setters.setBrand).toHaveBeenCalledWith("Visa");
    expect(setters.setBrandSource).toHaveBeenCalledWith("manual");

    callbacks.onDateOfBirthChange("2001-01-01");
    expect(setters.setDateOfBirth).toHaveBeenCalledWith("2001-01-01");
    expect(setters.setDobError).toHaveBeenCalledWith(null);

    callbacks.onIssueDateChange("2020-01-01");
    callbacks.onExpiryDateChange("2030-01-01");
    expect(setters.setIssueDate).toHaveBeenCalledWith("2020-01-01");
    expect(setters.setExpiryDate).toHaveBeenCalledWith("2030-01-01");
    expect(setters.setExpiryError).toHaveBeenNthCalledWith(1, null);
    expect(setters.setExpiryError).toHaveBeenNthCalledWith(2, null);
  });
});
