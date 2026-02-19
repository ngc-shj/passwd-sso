// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  selectPersonalEntryValues,
  usePersonalPasswordFormState,
} from "@/hooks/use-personal-password-form-state";

describe("usePersonalPasswordFormState", () => {
  it("initializes defaults without initial data", () => {
    const { result } = renderHook(() => usePersonalPasswordFormState());

    expect(result.current.values.title).toBe("");
    expect(result.current.values.username).toBe("");
    expect(result.current.values.password).toBe("");
    expect(result.current.values.folderId).toBeNull();
    expect(result.current.values.showTotpInput).toBe(false);
    expect(result.current.values.requireReprompt).toBe(false);
  });

  it("applies initial data and updates via setters", () => {
    const { result } = renderHook(() =>
      usePersonalPasswordFormState({
        id: "entry-1",
        title: "initial title",
        username: "initial-user",
        password: "initial-pass",
        url: "https://example.com",
        notes: "memo",
        tags: [],
        folderId: "folder-1",
        requireReprompt: true,
        totp: { secret: "secret", period: 30, digits: 6 },
      }),
    );

    expect(result.current.values.title).toBe("initial title");
    expect(result.current.values.folderId).toBe("folder-1");
    expect(result.current.values.showTotpInput).toBe(true);
    expect(result.current.values.requireReprompt).toBe(true);

    act(() => {
      result.current.setters.setTitle("updated");
      result.current.setters.setFolderId("folder-2");
      result.current.setters.setRequireReprompt(false);
    });

    expect(result.current.values.title).toBe("updated");
    expect(result.current.values.folderId).toBe("folder-2");
    expect(result.current.values.requireReprompt).toBe(false);
  });

  it("selects entry values for controller submit", () => {
    const { result } = renderHook(() =>
      usePersonalPasswordFormState({
        id: "entry-1",
        title: "title",
        username: "user",
        password: "pass",
        url: "https://example.com",
        notes: "memo",
        tags: [],
      }),
    );

    const selected = selectPersonalEntryValues(result.current.values);

    expect(selected).toEqual(
      expect.objectContaining({
        title: "title",
        username: "user",
        password: "pass",
        url: "https://example.com",
        notes: "memo",
      }),
    );
  });
});
