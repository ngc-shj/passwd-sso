// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTeamPasswordFormUiState } from "@/hooks/team/use-team-password-form-ui-state";

describe("useTeamPasswordFormUiState", () => {
  it("initializes every visibility/save flag to false", () => {
    const { result } = renderHook(() => useTeamPasswordFormUiState());

    expect(result.current.values).toEqual({
      saving: false,
      showPassword: false,
      showGenerator: false,
      showCardNumber: false,
      showCvv: false,
      showIdNumber: false,
      showCredentialId: false,
      showAccountNumber: false,
      showRoutingNumber: false,
      showLicenseKey: false,
    });
  });

  it("toggles saving via setSaving", () => {
    const { result } = renderHook(() => useTeamPasswordFormUiState());

    act(() => {
      result.current.setters.setSaving(true);
    });

    expect(result.current.values.saving).toBe(true);
  });

  it("flips each visibility flag independently through its setter", () => {
    const { result } = renderHook(() => useTeamPasswordFormUiState());

    act(() => {
      result.current.setters.setShowPassword(true);
      result.current.setters.setShowGenerator(true);
      result.current.setters.setShowCardNumber(true);
      result.current.setters.setShowCvv(true);
      result.current.setters.setShowIdNumber(true);
      result.current.setters.setShowCredentialId(true);
      result.current.setters.setShowAccountNumber(true);
      result.current.setters.setShowRoutingNumber(true);
      result.current.setters.setShowLicenseKey(true);
    });

    expect(result.current.values).toEqual({
      saving: false,
      showPassword: true,
      showGenerator: true,
      showCardNumber: true,
      showCvv: true,
      showIdNumber: true,
      showCredentialId: true,
      showAccountNumber: true,
      showRoutingNumber: true,
      showLicenseKey: true,
    });
  });

  it("returns to false when a setter toggles the flag back", () => {
    const { result } = renderHook(() => useTeamPasswordFormUiState());

    act(() => {
      result.current.setters.setShowPassword(true);
    });
    expect(result.current.values.showPassword).toBe(true);

    act(() => {
      result.current.setters.setShowPassword(false);
    });
    expect(result.current.values.showPassword).toBe(false);
  });
});
