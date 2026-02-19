// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOrgPasswordFormLifecycle } from "@/hooks/use-org-password-form-lifecycle";
import { createOrgPasswordFormLifecycleSettersMock } from "@/test-utils/org-password-form-setters";

const applyOrgEditDataToFormMock = vi.fn();
const resetOrgFormForCloseMock = vi.fn();

vi.mock("@/hooks/org-password-form-lifecycle-state", () => ({
  applyOrgEditDataToForm: (...args: unknown[]) => applyOrgEditDataToFormMock(...args),
  resetOrgFormForClose: (...args: unknown[]) => resetOrgFormForCloseMock(...args),
}));

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
        setters: createOrgPasswordFormLifecycleSettersMock(),
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
        setters: createOrgPasswordFormLifecycleSettersMock(),
      }),
    );

    result.current.handleOpenChange(false);

    expect(resetOrgFormForCloseMock).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
