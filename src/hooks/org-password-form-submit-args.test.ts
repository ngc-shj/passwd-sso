import { describe, expect, it, vi } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { buildOrgPasswordSubmitArgs } from "@/hooks/org-password-form-submit-args";
import type { useOrgPasswordFormState } from "@/hooks/use-org-password-form-state";

describe("buildOrgPasswordSubmitArgs", () => {
  it("maps form state and callbacks into submit args", () => {
    const setDobError = vi.fn();
    const setExpiryError = vi.fn();
    const setSaving = vi.fn();
    const onSaved = vi.fn();
    const handleOpenChange = vi.fn();

    const args = buildOrgPasswordSubmitArgs({
      orgId: "org-1",
      isEdit: true,
      editData: { id: "entry-1", title: "t", username: null, password: "p", url: null, notes: null },
      effectiveEntryType: ENTRY_TYPE.LOGIN,
      cardNumberValid: true,
      isIdentity: false,
      t: (key) => key,
      ti: (key) => key,
      onSaved,
      handleOpenChange,
      formState: createFormState({ setDobError, setExpiryError, setSaving }),
    });

    expect(args.orgId).toBe("org-1");
    expect(args.editData?.id).toBe("entry-1");
    expect(args.title).toBe("title");
    expect(args.password).toBe("pass");
    expect(args.identityErrorCopy.dobFuture).toBe("dobFuture");
    expect(args.identityErrorCopy.expiryBeforeIssue).toBe("expiryBeforeIssue");
    expect(args.setDobError).toBe(setDobError);
    expect(args.setExpiryError).toBe(setExpiryError);
    expect(args.setSaving).toBe(setSaving);
    expect(args.onSaved).toBe(onSaved);
    expect(args.handleOpenChange).toBe(handleOpenChange);
  });
});

function createFormState({
  setDobError,
  setExpiryError,
  setSaving,
}: {
  setDobError: (value: string | null) => void;
  setExpiryError: (value: string | null) => void;
  setSaving: (value: boolean) => void;
}) {
  return {
    values: {
      title: "title",
      notes: "notes",
      selectedTags: [],
      orgFolderId: null,
      username: "user",
      password: "pass",
      url: "https://example.com",
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
      dateOfBirth: "",
      nationality: "",
      idNumber: "",
      issueDate: "",
      expiryDate: "",
      relyingPartyId: "",
      relyingPartyName: "",
      credentialId: "",
      creationDate: "",
      deviceInfo: "",
    },
    setters: {
      setDobError,
      setExpiryError,
      setSaving,
    },
  } as unknown as ReturnType<typeof useOrgPasswordFormState>;
}
