// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useOrgPasswordFormUiState } from "@/hooks/use-team-password-form-ui-state";

describe("useOrgPasswordFormUiState", () => {
  it("initializes all ui flags as false", () => {
    const { result } = renderHook(() => useOrgPasswordFormUiState());

    expect(result.current.values.saving).toBe(false);
    expect(result.current.values.showPassword).toBe(false);
    expect(result.current.values.showGenerator).toBe(false);
    expect(result.current.values.showCardNumber).toBe(false);
    expect(result.current.values.showCvv).toBe(false);
    expect(result.current.values.showIdNumber).toBe(false);
    expect(result.current.values.showCredentialId).toBe(false);
  });

  it("updates ui flags via setters", () => {
    const { result } = renderHook(() => useOrgPasswordFormUiState());

    act(() => {
      result.current.setters.setSaving(true);
      result.current.setters.setShowPassword(true);
      result.current.setters.setShowGenerator(true);
      result.current.setters.setShowCardNumber(true);
      result.current.setters.setShowCvv(true);
      result.current.setters.setShowIdNumber(true);
      result.current.setters.setShowCredentialId(true);
    });

    expect(result.current.values.saving).toBe(true);
    expect(result.current.values.showPassword).toBe(true);
    expect(result.current.values.showGenerator).toBe(true);
    expect(result.current.values.showCardNumber).toBe(true);
    expect(result.current.values.showCvv).toBe(true);
    expect(result.current.values.showIdNumber).toBe(true);
    expect(result.current.values.showCredentialId).toBe(true);
  });
});
