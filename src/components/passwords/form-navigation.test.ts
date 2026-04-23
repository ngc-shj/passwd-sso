import { describe, expect, it, vi } from "vitest";
import { createFormNavigationHandlers } from "@/components/passwords/shared/form-navigation";

describe("createFormNavigationHandlers", () => {
  it("calls onCancel on cancel when provided", () => {
    const onCancel = vi.fn();
    const router = { back: vi.fn() };
    const { handleCancel } = createFormNavigationHandlers({ onCancel, router });

    handleCancel();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(router.back).not.toHaveBeenCalled();
  });

  it("falls back to router.back and supports back action", () => {
    const router = { back: vi.fn() };
    const { handleCancel, handleBack } = createFormNavigationHandlers({ router });

    handleCancel();
    handleBack();

    expect(router.back).toHaveBeenCalledTimes(2);
  });
});
