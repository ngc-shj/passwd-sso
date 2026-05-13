import { describe, it, expect } from "vitest";
import {
  readApiErrorBody,
  getApiErrorMessage,
  getApiErrorDetail,
  getApiErrorFieldErrors,
  readMainApiErrorBody,
} from "./read-api-error-body";

const makeJsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("readApiErrorBody", () => {
  it("returns null when response is ok (no error envelope to read)", async () => {
    const res = new Response(JSON.stringify({ ok: true }), { status: 200 });
    expect(await readApiErrorBody(res)).toBeNull();
  });

  it("returns the typed envelope for a well-formed error body", async () => {
    const res = makeJsonResponse({ error: "VALIDATION_ERROR" }, 400);
    const body = await readApiErrorBody(res);
    expect(body).toEqual({ error: "VALIDATION_ERROR" });
  });

  it("preserves details + lockedUntil + currentKeyVersion when present (C4 closed list)", async () => {
    const res = makeJsonResponse(
      {
        error: "ACCOUNT_LOCKED",
        lockedUntil: "2026-01-01T00:00:00.000Z",
        currentKeyVersion: 7,
        details: { properties: { x: { errors: ["bad"] } } },
      },
      403,
    );
    const body = await readApiErrorBody(res);
    expect(body?.error).toBe("ACCOUNT_LOCKED");
    expect(body?.lockedUntil).toBe("2026-01-01T00:00:00.000Z");
    expect(body?.currentKeyVersion).toBe(7);
    expect(body?.details).toBeDefined();
  });

  it("returns null when body is not JSON", async () => {
    const res = new Response("<html>500 error page</html>", {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
    expect(await readApiErrorBody(res)).toBeNull();
  });

  it("returns null when JSON body is missing the error field", async () => {
    const res = makeJsonResponse({ message: "oops" }, 500);
    expect(await readApiErrorBody(res)).toBeNull();
  });

  it("returns null when JSON body's error field is not a string", async () => {
    const res = makeJsonResponse({ error: 42 }, 500);
    expect(await readApiErrorBody(res)).toBeNull();
  });

  it("returns null when body is a JSON primitive (not an object)", async () => {
    const res = makeJsonResponse("just a string", 500);
    expect(await readApiErrorBody(res)).toBeNull();
  });

  it("returns null when body is JSON null", async () => {
    const res = makeJsonResponse(null, 500);
    expect(await readApiErrorBody(res)).toBeNull();
  });
});

describe("getApiErrorMessage", () => {
  it("returns the message string when details.message is a string", () => {
    const body = {
      error: "VALIDATION_ERROR" as const,
      details: { message: "Maximum 100 items allowed" },
    };
    expect(getApiErrorMessage(body)).toBe("Maximum 100 items allowed");
  });

  it("returns null when body is null", () => {
    expect(getApiErrorMessage(null)).toBeNull();
  });

  it("returns null when details is missing", () => {
    expect(getApiErrorMessage({ error: "FORBIDDEN" })).toBeNull();
  });

  it("returns null when details is null", () => {
    expect(
      getApiErrorMessage({ error: "FORBIDDEN", details: null }),
    ).toBeNull();
  });

  it("returns null when details.message is not a string", () => {
    expect(
      getApiErrorMessage({
        error: "FORBIDDEN",
        details: { message: 42 },
      } as Parameters<typeof getApiErrorMessage>[0]),
    ).toBeNull();
  });

  it("returns null when details has no message field (e.g., Zod tree shape)", () => {
    expect(
      getApiErrorMessage({
        error: "VALIDATION_ERROR",
        details: { properties: { x: { errors: ["bad"] } } },
      }),
    ).toBeNull();
  });
});

describe("getApiErrorDetail", () => {
  const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
  const isString = (v: unknown): v is string => typeof v === "string";

  it("returns the typed value when the field exists and the guard accepts it", () => {
    const body = {
      error: "SYNC_FAILED" as const,
      details: { abortedSafety: true, info: "limit hit" },
    };
    expect(getApiErrorDetail(body, "abortedSafety", isBoolean)).toBe(true);
    expect(getApiErrorDetail(body, "info", isString)).toBe("limit hit");
  });

  it("returns null when the guard rejects the value", () => {
    const body = {
      error: "SYNC_FAILED" as const,
      details: { abortedSafety: "not-a-boolean" },
    };
    expect(getApiErrorDetail(body, "abortedSafety", isBoolean)).toBeNull();
  });

  it("returns null when body is null", () => {
    expect(getApiErrorDetail(null, "abortedSafety", isBoolean)).toBeNull();
  });

  it("returns null when details is missing or non-object", () => {
    expect(
      getApiErrorDetail({ error: "FORBIDDEN" }, "abortedSafety", isBoolean),
    ).toBeNull();
    expect(
      getApiErrorDetail(
        { error: "FORBIDDEN", details: null },
        "abortedSafety",
        isBoolean,
      ),
    ).toBeNull();
  });

  it("returns null when the field is absent", () => {
    expect(
      getApiErrorDetail(
        { error: "SYNC_FAILED", details: { otherField: 1 } },
        "abortedSafety",
        isBoolean,
      ),
    ).toBeNull();
  });
});

describe("getApiErrorFieldErrors", () => {
  it("returns the per-field errors array from a Zod treeifyError shape", () => {
    const body = {
      error: "VALIDATION_ERROR" as const,
      details: {
        properties: {
          slug: { errors: ["String must contain at least 1 character(s)"] },
        },
      },
    };
    expect(getApiErrorFieldErrors(body, "slug")).toEqual([
      "String must contain at least 1 character(s)",
    ]);
  });

  it("returns null when body is null", () => {
    expect(getApiErrorFieldErrors(null, "slug")).toBeNull();
  });

  it("returns null when details is missing or non-object", () => {
    expect(
      getApiErrorFieldErrors({ error: "VALIDATION_ERROR" }, "slug"),
    ).toBeNull();
    expect(
      getApiErrorFieldErrors(
        { error: "VALIDATION_ERROR", details: null },
        "slug",
      ),
    ).toBeNull();
  });

  it("returns null when properties is missing (e.g., message-only details)", () => {
    expect(
      getApiErrorFieldErrors(
        { error: "VALIDATION_ERROR", details: { message: "bad" } },
        "slug",
      ),
    ).toBeNull();
  });

  it("returns null when the named field has no errors entry", () => {
    expect(
      getApiErrorFieldErrors(
        {
          error: "VALIDATION_ERROR",
          details: { properties: { slug: { otherField: 1 } } },
        },
        "slug",
      ),
    ).toBeNull();
  });

  it("returns null when the field's errors entry is not an array", () => {
    expect(
      getApiErrorFieldErrors(
        {
          error: "VALIDATION_ERROR",
          details: { properties: { slug: { errors: "not-an-array" } } },
        },
        "slug",
      ),
    ).toBeNull();
  });

  it("returns null when the named field is absent from properties", () => {
    expect(
      getApiErrorFieldErrors(
        {
          error: "VALIDATION_ERROR",
          details: { properties: { url: { errors: ["bad"] } } },
        },
        "slug",
      ),
    ).toBeNull();
  });
});

describe("readMainApiErrorBody", () => {
  it("narrows a well-formed object to MainApiErrorBody", () => {
    expect(readMainApiErrorBody({ error: "FORBIDDEN" })).toEqual({
      error: "FORBIDDEN",
    });
  });

  it("returns null for null / undefined / primitives", () => {
    expect(readMainApiErrorBody(null)).toBeNull();
    expect(readMainApiErrorBody(undefined)).toBeNull();
    expect(readMainApiErrorBody("string")).toBeNull();
    expect(readMainApiErrorBody(42)).toBeNull();
    expect(readMainApiErrorBody(true)).toBeNull();
  });

  it("returns null when the error field is missing", () => {
    expect(readMainApiErrorBody({ message: "oops" })).toBeNull();
  });

  it("returns null when the error field is not a string", () => {
    expect(readMainApiErrorBody({ error: 42 })).toBeNull();
    expect(readMainApiErrorBody({ error: null })).toBeNull();
    expect(readMainApiErrorBody({ error: { code: "X" } })).toBeNull();
  });
});
