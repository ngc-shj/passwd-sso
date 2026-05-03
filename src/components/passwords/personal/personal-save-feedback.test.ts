/**
 * personal-save-feedback — toast + router routing tests
 *
 * Covers:
 *   - error response triggers toast.error and does NOT navigate
 *   - success on create triggers `saved` toast
 *   - success on edit triggers `updated` toast
 *   - if onSaved is provided, router is NOT invoked
 *   - if onSaved is omitted, router.push("/dashboard") + router.refresh()
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockToastError, mockToastSuccess } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mockToastError, success: mockToastSuccess },
}));

import { handlePersonalSaveFeedback } from "./personal-save-feedback";

const t = (key: "saved" | "updated" | "failedToSave") => key;

function makeRouter() {
  return { push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn() };
}

describe("handlePersonalSaveFeedback", () => {
  beforeEach(() => {
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
  });

  it("emits an error toast and does not navigate when response is not ok", () => {
    const router = makeRouter();
    const onSaved = vi.fn();

    handlePersonalSaveFeedback({
      res: { ok: false } as Response,
      mode: "create",
      t,
      router,
      onSaved,
    });

    expect(mockToastError).toHaveBeenCalledWith("failedToSave");
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("emits the saved toast on successful create", () => {
    const router = makeRouter();

    handlePersonalSaveFeedback({
      res: { ok: true } as Response,
      mode: "create",
      t,
      router,
    });

    expect(mockToastSuccess).toHaveBeenCalledWith("saved");
  });

  it("emits the updated toast on successful edit", () => {
    const router = makeRouter();

    handlePersonalSaveFeedback({
      res: { ok: true } as Response,
      mode: "edit",
      t,
      router,
    });

    expect(mockToastSuccess).toHaveBeenCalledWith("updated");
  });

  it("invokes onSaved (and skips router) when provided on success", () => {
    const router = makeRouter();
    const onSaved = vi.fn();

    handlePersonalSaveFeedback({
      res: { ok: true } as Response,
      mode: "create",
      t,
      router,
      onSaved,
    });

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("falls back to router.push + refresh when onSaved is not provided", () => {
    const router = makeRouter();

    handlePersonalSaveFeedback({
      res: { ok: true } as Response,
      mode: "edit",
      t,
      router,
    });

    expect(router.push).toHaveBeenCalledWith("/dashboard");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});
