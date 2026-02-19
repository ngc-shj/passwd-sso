// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOrgPasswordFormLifecycle } from "@/hooks/use-org-password-form-lifecycle";

const applyOrgEditDataToFormMock = vi.fn();
const resetOrgFormForCloseMock = vi.fn();

vi.mock("@/hooks/org-password-form-lifecycle-state", () => ({
  applyOrgEditDataToForm: (...args: unknown[]) => applyOrgEditDataToFormMock(...args),
  resetOrgFormForClose: (...args: unknown[]) => resetOrgFormForCloseMock(...args),
}));

function createSetters() {
  const noop = vi.fn();
  return {
    setTitle: noop,
    setUsername: noop,
    setPassword: noop,
    setContent: noop,
    setUrl: noop,
    setNotes: noop,
    setSelectedTags: noop,
    setCustomFields: noop,
    setTotp: noop,
    setShowTotpInput: noop,
    setCardholderName: noop,
    setCardNumber: noop,
    setBrand: noop,
    setBrandSource: noop,
    setExpiryMonth: noop,
    setExpiryYear: noop,
    setCvv: noop,
    setFullName: noop,
    setAddress: noop,
    setPhone: noop,
    setEmail: noop,
    setDateOfBirth: noop,
    setNationality: noop,
    setIdNumber: noop,
    setIssueDate: noop,
    setExpiryDate: noop,
    setRelyingPartyId: noop,
    setRelyingPartyName: noop,
    setCredentialId: noop,
    setCreationDate: noop,
    setDeviceInfo: noop,
    setOrgFolderId: noop,
    setShowPassword: noop,
    setShowGenerator: noop,
    setShowCardNumber: noop,
    setShowCvv: noop,
    setShowIdNumber: noop,
    setShowCredentialId: noop,
    setAttachments: noop,
    setSaving: noop,
  };
}

describe("useOrgPasswordFormLifecycle", () => {
  beforeEach(() => {
    applyOrgEditDataToFormMock.mockReset();
    resetOrgFormForCloseMock.mockReset();
  });

  it("applies edit data when opened with editData", () => {
    renderHook(() =>
      useOrgPasswordFormLifecycle({
        open: true,
        editData: {
          id: "e1",
          title: "t",
          username: "u",
          password: "p",
          url: null,
          notes: null,
          tags: [],
        },
        onOpenChange: vi.fn(),
        setters: createSetters(),
      }),
    );

    expect(applyOrgEditDataToFormMock).toHaveBeenCalledTimes(1);
  });

  it("resets form when closing via handleOpenChange", () => {
    const onOpenChange = vi.fn();

    const { result } = renderHook(() =>
      useOrgPasswordFormLifecycle({
        open: true,
        editData: null,
        onOpenChange,
        setters: createSetters(),
      }),
    );

    result.current.handleOpenChange(false);

    expect(resetOrgFormForCloseMock).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
