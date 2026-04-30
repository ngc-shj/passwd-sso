import { describe, it, expect, vi, beforeEach } from "vitest";

const mockToastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: mockToastError } }));

import { toastApiError } from "./toast-api-error";
import { API_ERROR } from "./api-error-codes";

const tErrors = (key: string): string => `t:${key}`;

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

describe("toastApiError", () => {
  beforeEach(() => {
    mockToastError.mockClear();
  });

  it("maps known error codes to their i18n keys", async () => {
    await toastApiError(jsonRes({ error: API_ERROR.FORBIDDEN }), tErrors);
    expect(mockToastError).toHaveBeenCalledWith("t:forbidden");
  });

  it("falls back to unknownError when the code is missing and no fallback is provided", async () => {
    await toastApiError(jsonRes({}), tErrors);
    expect(mockToastError).toHaveBeenCalledWith("t:unknownError");
  });

  it("uses the provided fallbackErrorCode when body.error is missing", async () => {
    await toastApiError(jsonRes({}), tErrors, API_ERROR.FORBIDDEN);
    expect(mockToastError).toHaveBeenCalledWith("t:forbidden");
  });

  it("body.error wins over fallback when both present", async () => {
    await toastApiError(
      jsonRes({ error: API_ERROR.FORBIDDEN_INSUFFICIENT_ROLE }),
      tErrors,
      API_ERROR.FORBIDDEN,
    );
    expect(mockToastError).toHaveBeenCalledWith("t:forbiddenInsufficientRole");
  });

  it("falls back to unknownError when body parse fails", async () => {
    const res = new Response("not-json", { status: 500 });
    await toastApiError(res, tErrors);
    expect(mockToastError).toHaveBeenCalledWith("t:unknownError");
  });

  it("uses fallback even when body parse fails, if provided", async () => {
    const res = new Response("not-json", { status: 500 });
    await toastApiError(res, tErrors, API_ERROR.INTERNAL_ERROR);
    expect(mockToastError).toHaveBeenCalledWith("t:internalError");
  });

  it("returns 'unknownError' for an unrecognized code", async () => {
    await toastApiError(jsonRes({ error: "BOGUS_CODE" }), tErrors);
    expect(mockToastError).toHaveBeenCalledWith("t:unknownError");
  });
});
