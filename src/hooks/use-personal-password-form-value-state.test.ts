// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildPersonalPasswordFormInitialValues } from "@/hooks/personal-password-form-initial-values";
import { usePersonalPasswordFormValueState } from "@/hooks/use-personal-password-form-value-state";

describe("usePersonalPasswordFormValueState", () => {
  it("initializes with provided initial values", () => {
    const initial = buildPersonalPasswordFormInitialValues({
      id: "entry-1",
      title: "Personal Title",
      username: "user@example.com",
      password: "secret",
      notes: "memo",
      folderId: "folder-1",
    });

    const { result } = renderHook(() => usePersonalPasswordFormValueState(initial));

    expect(result.current.values.title).toBe("Personal Title");
    expect(result.current.values.username).toBe("user@example.com");
    expect(result.current.values.password).toBe("secret");
    expect(result.current.values.notes).toBe("memo");
    expect(result.current.values.folderId).toBe("folder-1");
  });

  it("updates values through setters", () => {
    const initial = buildPersonalPasswordFormInitialValues();
    const { result } = renderHook(() => usePersonalPasswordFormValueState(initial));

    act(() => {
      result.current.setters.setTitle("Updated");
      result.current.setters.setPassword("updated-pass");
      result.current.setters.setFolderId("folder-2");
    });

    expect(result.current.values.title).toBe("Updated");
    expect(result.current.values.password).toBe("updated-pass");
    expect(result.current.values.folderId).toBe("folder-2");
  });
});
