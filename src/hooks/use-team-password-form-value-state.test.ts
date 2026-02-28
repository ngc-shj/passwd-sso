// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildTeamPasswordFormInitialValues } from "@/hooks/team-password-form-initial-values";
import { useTeamPasswordFormValueState } from "@/hooks/use-team-password-form-value-state";
import { ENTRY_TYPE } from "@/lib/constants";

describe("useTeamPasswordFormValueState", () => {
  it("initializes from prepared initial values", () => {
    const initial = buildTeamPasswordFormInitialValues({
      id: "e1",
      entryType: ENTRY_TYPE.LOGIN,
      title: "GitHub",
      username: "user@example.com",
      password: "secret",
      notes: "note",
      teamFolderId: "folder-1",
    });

    const { result } = renderHook(() => useTeamPasswordFormValueState(initial));

    expect(result.current.values.title).toBe("GitHub");
    expect(result.current.values.username).toBe("user@example.com");
    expect(result.current.values.password).toBe("secret");
    expect(result.current.values.notes).toBe("note");
    expect(result.current.values.teamFolderId).toBe("folder-1");
    expect(result.current.values.requireReprompt).toBe(false);
    expect(result.current.values.expiresAt).toBeNull();
  });

  it("updates values via setters", () => {
    const initial = buildTeamPasswordFormInitialValues();
    const { result } = renderHook(() => useTeamPasswordFormValueState(initial));

    act(() => {
      result.current.setters.setTitle("Updated");
      result.current.setters.setPassword("updated-pass");
      result.current.setters.setTeamFolderId("folder-2");
    });

    expect(result.current.values.title).toBe("Updated");
    expect(result.current.values.password).toBe("updated-pass");
    expect(result.current.values.teamFolderId).toBe("folder-2");
  });

  it("initializes requireReprompt and expiresAt from edit data", () => {
    const initial = buildTeamPasswordFormInitialValues({
      id: "e2",
      entryType: ENTRY_TYPE.LOGIN,
      title: "Test",
      username: "u",
      password: "p",
      requireReprompt: true,
      expiresAt: "2026-12-31T00:00:00Z",
    });

    const { result } = renderHook(() => useTeamPasswordFormValueState(initial));

    expect(result.current.values.requireReprompt).toBe(true);
    expect(result.current.values.expiresAt).toBe("2026-12-31T00:00:00Z");
  });

  it("updates requireReprompt and expiresAt via setters", () => {
    const initial = buildTeamPasswordFormInitialValues();
    const { result } = renderHook(() => useTeamPasswordFormValueState(initial));

    act(() => {
      result.current.setters.setRequireReprompt(true);
      result.current.setters.setExpiresAt("2026-06-15T00:00:00Z");
    });

    expect(result.current.values.requireReprompt).toBe(true);
    expect(result.current.values.expiresAt).toBe("2026-06-15T00:00:00Z");
  });
});
