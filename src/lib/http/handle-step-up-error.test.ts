import { describe, it, expect, vi } from "vitest";
import {
  isStepUpRequired,
  handleStepUpError,
  StepUpRequiredError,
  isStepUpRequiredError,
  throwIfStepUp,
} from "@/lib/http/handle-step-up-error";
import { API_ERROR } from "@/lib/http/api-error-codes";

function stepUp403(): Response {
  return {
    ok: false,
    status: 403,
    json: () => Promise.resolve({ error: API_ERROR.SESSION_STEP_UP_REQUIRED }),
  } as unknown as Response;
}

function otherError(status: number, error?: string): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve(error ? { error } : {}),
  } as unknown as Response;
}

describe("isStepUpRequired", () => {
  it("returns true for a step-up error body", () => {
    expect(isStepUpRequired({ error: API_ERROR.SESSION_STEP_UP_REQUIRED })).toBe(
      true,
    );
  });

  it("returns false for a different error code", () => {
    expect(isStepUpRequired({ error: API_ERROR.FORBIDDEN })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isStepUpRequired(null)).toBe(false);
  });
});

describe("handleStepUpError", () => {
  it("triggers reauth and returns true on a step-up 403", async () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    const handled = await handleStepUpError(stepUp403(), trigger);
    expect(handled).toBe(true);
    expect(trigger).toHaveBeenCalledOnce();
  });

  it("passes the retry arg through to the trigger", async () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    await handleStepUpError(stepUp403(), trigger, { type: "delete", id: "x" });
    expect(trigger).toHaveBeenCalledWith({ type: "delete", id: "x" });
  });

  it("returns false and does NOT trigger on a non-step-up error", async () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    const handled = await handleStepUpError(otherError(409, "NAME_CONFLICT"), trigger);
    expect(handled).toBe(false);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("returns false on an error body that is not the envelope shape", async () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    const handled = await handleStepUpError(otherError(500), trigger);
    expect(handled).toBe(false);
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe("throwIfStepUp / StepUpRequiredError", () => {
  it("throws StepUpRequiredError on a step-up 403", async () => {
    await expect(throwIfStepUp(stepUp403())).rejects.toBeInstanceOf(
      StepUpRequiredError,
    );
  });

  it("does not throw on an ok response", async () => {
    await expect(
      throwIfStepUp({ ok: true } as unknown as Response),
    ).resolves.toBeUndefined();
  });

  it("does not throw on a non-step-up error (caller throws its own)", async () => {
    await expect(
      throwIfStepUp(otherError(500)),
    ).resolves.toBeUndefined();
  });

  it("isStepUpRequiredError narrows the thrown error", () => {
    const e: unknown = new StepUpRequiredError();
    expect(isStepUpRequiredError(e)).toBe(true);
    expect(isStepUpRequiredError(new Error("other"))).toBe(false);
  });

  it("StepUpRequiredError carries the canonical code", () => {
    expect(new StepUpRequiredError().code).toBe(
      API_ERROR.SESSION_STEP_UP_REQUIRED,
    );
  });
});
