// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildPersonalLoginFormInitialValues } from "@/hooks/personal/personal-login-form-initial-values";
import { usePersonalLoginFormValueState } from "@/hooks/personal/use-personal-login-form-value-state";

describe("usePersonalLoginFormValueState", () => {
  it("initializes with provided initial values", () => {
    const initial = buildPersonalLoginFormInitialValues({
      id: "entry-1",
      title: "Personal Title",
      username: "user@example.com",
      password: "secret",
      url: "https://example.com",
      notes: "memo",
      tags: [],
      folderId: "folder-1",
    });

    const { result } = renderHook(() => usePersonalLoginFormValueState(initial));

    expect(result.current.values.title).toBe("Personal Title");
    expect(result.current.values.username).toBe("user@example.com");
    expect(result.current.values.password).toBe("secret");
    expect(result.current.values.notes).toBe("memo");
    expect(result.current.values.folderId).toBe("folder-1");
  });

  it("updates values through setters", () => {
    const initial = buildPersonalLoginFormInitialValues();
    const { result } = renderHook(() => usePersonalLoginFormValueState(initial));

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
