// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTeamPasswordFormLifecycle } from "@/hooks/use-team-password-form-lifecycle";
import { createTeamPasswordFormLifecycleSettersMock } from "@/test-utils/team-password-form-setters";

describe("useTeamPasswordFormLifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies edit data when opened with editData", () => {
    const setters = createTeamPasswordFormLifecycleSettersMock();

    renderHook(() =>
      useTeamPasswordFormLifecycle({
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
        setters,
      }),
    );

    expect(setters.setTitle).toHaveBeenCalledWith("t");
    expect(setters.setUsername).toHaveBeenCalledWith("u");
    expect(setters.setPassword).toHaveBeenCalledWith("p");
  });

  it("resets form when closing via handleOpenChange", () => {
    const onOpenChange = vi.fn();
    const setters = createTeamPasswordFormLifecycleSettersMock();

    const { result } = renderHook(() =>
      useTeamPasswordFormLifecycle({
        open: true,
        editData: null,
        onOpenChange,
        setters,
      }),
    );

    result.current.handleOpenChange(false);

    expect(setters.setTitle).toHaveBeenCalledWith("");
    expect(setters.setSaving).toHaveBeenCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
