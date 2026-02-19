import { describe, expect, it, vi } from "vitest";
import { createFormNavigationHandlers } from "@/components/passwords/form-navigation";

describe("createFormNavigationHandlers", () => {
  it("calls onSaved on cancel when provided", () => {
    const onSaved = vi.fn();
    const router = { back: vi.fn() };
    const { handleCancel } = createFormNavigationHandlers({ onSaved, router });

    handleCancel();

    expect(onSaved).toHaveBeenCalledTimes(1);
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
