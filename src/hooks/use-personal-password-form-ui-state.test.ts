// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePersonalPasswordFormUiState } from "@/hooks/use-personal-password-form-ui-state";

describe("usePersonalPasswordFormUiState", () => {
  it("initializes ui flags", () => {
    const { result } = renderHook(() => usePersonalPasswordFormUiState());

    expect(result.current.values.showPassword).toBe(false);
    expect(result.current.values.showGenerator).toBe(false);
    expect(result.current.values.submitting).toBe(false);
  });

  it("updates ui flags through setters", () => {
    const { result } = renderHook(() => usePersonalPasswordFormUiState());

    act(() => {
      result.current.setters.setShowPassword(true);
      result.current.setters.setShowGenerator(true);
      result.current.setters.setSubmitting(true);
    });

    expect(result.current.values.showPassword).toBe(true);
    expect(result.current.values.showGenerator).toBe(true);
    expect(result.current.values.submitting).toBe(true);
  });
});
