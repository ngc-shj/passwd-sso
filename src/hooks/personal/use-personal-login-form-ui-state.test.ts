// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePersonalLoginFormUiState } from "@/hooks/personal/use-personal-login-form-ui-state";

describe("usePersonalLoginFormUiState", () => {
  it("initializes ui flags", () => {
    const { result } = renderHook(() => usePersonalLoginFormUiState());

    expect(result.current.values.showPassword).toBe(false);
    expect(result.current.values.showGenerator).toBe(false);
    expect(result.current.values.submitting).toBe(false);
  });

  it("updates ui flags through setters", () => {
    const { result } = renderHook(() => usePersonalLoginFormUiState());

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
