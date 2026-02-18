import { describe, expect, it, vi } from "vitest";
import {
  applyOrgEditDataToForm,
  resetOrgFormForClose,
} from "@/components/org/org-password-form-state";

function createSetters() {
  return {
    setTitle: vi.fn(),
    setUsername: vi.fn(),
    setPassword: vi.fn(),
    setContent: vi.fn(),
    setUrl: vi.fn(),
    setNotes: vi.fn(),
    setSelectedTags: vi.fn(),
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
    setRelyingPartyId: vi.fn(),
    setRelyingPartyName: vi.fn(),
    setCredentialId: vi.fn(),
    setCreationDate: vi.fn(),
    setDeviceInfo: vi.fn(),
    setOrgFolderId: vi.fn(),
    setShowPassword: vi.fn(),
    setShowGenerator: vi.fn(),
    setShowCardNumber: vi.fn(),
    setShowCvv: vi.fn(),
    setShowIdNumber: vi.fn(),
    setShowCredentialId: vi.fn(),
    setAttachments: vi.fn(),
    setSaving: vi.fn(),
  };
}

describe("org-password-form-state", () => {
  it("applyOrgEditDataToForm applies incoming edit values", () => {
    const setters = createSetters();

    applyOrgEditDataToForm(
      {
        id: "entry-1",
        title: "Title",
        username: "user@example.com",
        password: "pw",
        content: "content",
        url: "https://example.com",
        notes: "notes",
        brand: "Visa",
        cardNumber: "4111111111111111",
        orgFolderId: "folder-1",
      },
      setters,
    );

    expect(setters.setTitle).toHaveBeenCalledWith("Title");
    expect(setters.setUsername).toHaveBeenCalledWith("user@example.com");
    expect(setters.setPassword).toHaveBeenCalledWith("pw");
    expect(setters.setContent).toHaveBeenCalledWith("content");
    expect(setters.setBrand).toHaveBeenCalledWith("Visa");
    expect(setters.setBrandSource).toHaveBeenCalledWith("manual");
    expect(setters.setOrgFolderId).toHaveBeenCalledWith("folder-1");
    expect(setters.setShowTotpInput).toHaveBeenCalledWith(false);
  });

  it("resetOrgFormForClose resets all mutable UI states", () => {
    const setters = createSetters();

    resetOrgFormForClose(setters);

    expect(setters.setTitle).toHaveBeenCalledWith("");
    expect(setters.setUsername).toHaveBeenCalledWith("");
    expect(setters.setPassword).toHaveBeenCalledWith("");
    expect(setters.setShowPassword).toHaveBeenCalledWith(false);
    expect(setters.setShowGenerator).toHaveBeenCalledWith(false);
    expect(setters.setBrandSource).toHaveBeenCalledWith("auto");
    expect(setters.setOrgFolderId).toHaveBeenCalledWith(null);
    expect(setters.setAttachments).toHaveBeenCalledWith([]);
    expect(setters.setSaving).toHaveBeenCalledWith(false);
  });
});
