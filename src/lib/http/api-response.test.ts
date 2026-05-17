import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { TeamAuthError } from "@/lib/auth/access/team-auth";
import {
  errorResponse,
  errorResponseWithMessage,
  unauthorized,
  notFound,
  forbidden,
  validationError,
  zodValidationError,
  rateLimited,
  serviceUnavailable,
  oauthTemporarilyUnavailable,
  prismaErrorResponse,
  handleAuthError,
} from "./api-response";

describe("errorResponse", () => {
  it("returns JSON with error code and status", async () => {
    const res = errorResponse(API_ERROR.NOT_FOUND, 404);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("derives status from API_ERROR_STATUS when omitted", async () => {
    const res = errorResponse(API_ERROR.CONFLICT);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "CONFLICT" });
  });

  it("explicit status overrides the default (used for documented exceptions)", async () => {
    // INVALID_ORIGIN defaults to 403; vault/admin-reset overrides to 500.
    const res = errorResponse(API_ERROR.INVALID_ORIGIN, 500);
    expect(res.status).toBe(500);
  });

  it("merges details into response body", async () => {
    const res = errorResponse(API_ERROR.VALIDATION_ERROR, 400, {
      details: { properties: { title: { errors: ["required"] } } },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.details.properties.title.errors).toEqual(["required"]);
  });

  it("omits details key when not provided", async () => {
    const res = errorResponse(API_ERROR.FORBIDDEN, 403);
    const body = await res.json();
    expect(body).toEqual({ error: "FORBIDDEN" });
    expect("details" in body).toBe(false);
  });
});

describe("rateLimited", () => {
  it("returns 429 with RATE_LIMIT_EXCEEDED error", async () => {
    const res = rateLimited();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "RATE_LIMIT_EXCEEDED" });
  });

  it("sets Retry-After header when retryAfterMs is provided (rounds up to seconds)", async () => {
    const res = rateLimited(1500);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("2");
  });

  it("omits Retry-After header when retryAfterMs is undefined", async () => {
    const res = rateLimited();
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("omits Retry-After header when retryAfterMs is 0", async () => {
    const res = rateLimited(0);
    expect(res.headers.get("Retry-After")).toBeNull();
  });
});

describe("serviceUnavailable", () => {
  // AC2.1
  it("returns 503 with default Retry-After: 30 when retryAfterMs omitted", async () => {
    const res = serviceUnavailable();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await res.json()).toEqual({ error: "SERVICE_UNAVAILABLE" });
  });

  // AC2.2
  it("sets Retry-After from retryAfterMs (rounds up)", async () => {
    const res = serviceUnavailable(15_000);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("15");
  });

  // AC2.3 — semantic divergence from rateLimited(0): 503 ALWAYS has Retry-After
  it("returns Retry-After: 30 when retryAfterMs is 0 (divergence from rateLimited)", async () => {
    const res = serviceUnavailable(0);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  // AC2.4 — body is exactly the minimal canonical envelope
  it("body contains no extra fields beyond { error: SERVICE_UNAVAILABLE }", async () => {
    const res = serviceUnavailable();
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["error"]);
  });
});

describe("oauthTemporarilyUnavailable", () => {
  // AC2b.1
  it("returns 503 with body { error: temporarily_unavailable } + Retry-After: 30", async () => {
    const res = oauthTemporarilyUnavailable();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await res.json()).toEqual({ error: "temporarily_unavailable" });
  });

  // AC2b.2
  it("body MUST NOT contain error_description (information-disclosure surface dropped)", async () => {
    const res = oauthTemporarilyUnavailable(15_000);
    expect(res.headers.get("Retry-After")).toBe("15");
    const body = await res.json();
    expect(body).toEqual({ error: "temporarily_unavailable" });
    expect("error_description" in body).toBe(false);
  });
});

describe("preset helpers", () => {
  it("unauthorized returns 401", async () => {
    const res = unauthorized();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "UNAUTHORIZED" });
  });

  it("notFound returns 404", async () => {
    const res = notFound();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("forbidden returns 403", async () => {
    const res = forbidden();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "FORBIDDEN" });
  });

  it("validationError returns 400 with details", async () => {
    const details = { properties: { email: { errors: ["invalid"] } } };
    const res = validationError(details);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.details).toEqual(details);
  });

  it("validationError() (no arg) returns 400 without details key", async () => {
    const res = validationError();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "VALIDATION_ERROR" });
    expect("details" in body).toBe(false);
  });

  it("zodValidationError returns treeifyError shape from ZodError", async () => {
    const schema = z.object({ name: z.string().min(1), age: z.number() });
    const result = schema.safeParse({ name: "", age: "not-a-number" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const res = zodValidationError(result.error);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.details).toHaveProperty("errors");
      expect(body.details).toHaveProperty("properties");
      expect(body.details.properties.name).toHaveProperty("errors");
      expect(body.details.properties.age).toHaveProperty("errors");
    }
  });
});

describe("errorResponseWithMessage", () => {
  it("2-arg form derives status from API_ERROR_STATUS", async () => {
    const res = errorResponseWithMessage(API_ERROR.NOT_FOUND, "missing entry");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "NOT_FOUND",
      details: { message: "missing entry" },
    });
  });

  it("2-arg form wraps message under details (C6 envelope)", async () => {
    const res = errorResponseWithMessage(
      API_ERROR.VALIDATION_ERROR,
      "exceeded cap",
    );
    const body = await res.json();
    // Per C6: free-form messages must be inside details, not top-level.
    expect(body).toEqual({
      error: "VALIDATION_ERROR",
      details: { message: "exceeded cap" },
    });
    expect("message" in body).toBe(false);
  });

  it("3-arg form uses explicit status (override path)", async () => {
    // SA_NOT_FOUND defaults to 404; this form lets a route override.
    const res = errorResponseWithMessage(
      API_ERROR.SA_NOT_FOUND,
      410,
      "Service account is permanently gone",
    );
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      error: "SA_NOT_FOUND",
      details: { message: "Service account is permanently gone" },
    });
  });

  it("3-arg form preserves status when it equals the default (no auto-strip)", async () => {
    // The helper does not silently drop matching status — that's the gate's job.
    const res = errorResponseWithMessage(API_ERROR.NOT_FOUND, 404, "missing");
    expect(res.status).toBe(404);
  });
});

describe("prismaErrorResponse", () => {
  it("maps PrismaClientInitializationError to 503 SERVICE_UNAVAILABLE", async () => {
    const err = new Prisma.PrismaClientInitializationError(
      "DB connection failed",
      "5.0.0",
    );
    const res = prismaErrorResponse(err);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
    expect(await res!.json()).toEqual({ error: "SERVICE_UNAVAILABLE" });
  });

  it("maps P2002 unique-constraint violation to 409 CONFLICT", async () => {
    const err = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "5.0.0" },
    );
    const res = prismaErrorResponse(err);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(409);
    expect(await res!.json()).toEqual({ error: "CONFLICT" });
  });

  it("maps P2003 foreign-key violation to 409 CONFLICT", async () => {
    const err = new Prisma.PrismaClientKnownRequestError("FK violation", {
      code: "P2003",
      clientVersion: "5.0.0",
    });
    const res = prismaErrorResponse(err);
    expect(res!.status).toBe(409);
  });

  it("maps P2025 record-not-found to 404 NOT_FOUND", async () => {
    const err = new Prisma.PrismaClientKnownRequestError("Record not found", {
      code: "P2025",
      clientVersion: "5.0.0",
    });
    const res = prismaErrorResponse(err);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
    expect(await res!.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("returns null for unrecognized Prisma error code (caller falls through)", () => {
    const err = new Prisma.PrismaClientKnownRequestError("Some other error", {
      code: "P9999",
      clientVersion: "5.0.0",
    });
    expect(prismaErrorResponse(err)).toBeNull();
  });

  it("returns null for non-Prisma error", () => {
    expect(prismaErrorResponse(new Error("boom"))).toBeNull();
    expect(prismaErrorResponse("string error")).toBeNull();
    expect(prismaErrorResponse(null)).toBeNull();
    expect(prismaErrorResponse(undefined)).toBeNull();
  });
});

describe("handleAuthError", () => {
  it("converts TeamAuthError to errorResponse with its code/status", async () => {
    const err = new TeamAuthError(API_ERROR.FORBIDDEN, 403);
    const res = handleAuthError(err);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "FORBIDDEN" });
  });

  it("recognizes duck-typed AuthError shape (name + status)", async () => {
    // handleAuthError uses duck-typing to avoid circular imports — any Error
    // subclass named TeamAuthError or TenantAuthError with a numeric status
    // is treated as an auth error.
    const fake = new Error(API_ERROR.NOT_FOUND);
    fake.name = "TenantAuthError";
    (fake as Error & { status: number }).status = 404;
    const res = handleAuthError(fake);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("re-throws an Error whose name does not match either AuthError class", () => {
    const generic = new Error("unrelated");
    expect(() => handleAuthError(generic)).toThrow(generic);
  });

  it("re-throws an Error named TeamAuthError but missing the status field", () => {
    // Status field is part of the contract; without it we cannot construct a
    // valid response, so the error must propagate as a programmer bug.
    const malformed = new Error(API_ERROR.FORBIDDEN);
    malformed.name = "TeamAuthError";
    expect(() => handleAuthError(malformed)).toThrow(malformed);
  });

  it("re-throws non-Error values unchanged", () => {
    expect(() => handleAuthError("string")).toThrow("string");
    expect(() => handleAuthError(42)).toThrow();
  });
});
