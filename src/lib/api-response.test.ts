import { describe, it, expect } from "vitest";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  errorResponse,
  unauthorized,
  notFound,
  forbidden,
  validationError,
  rateLimited,
} from "./api-response";

describe("errorResponse", () => {
  it("returns JSON with error code and status", async () => {
    const res = errorResponse(API_ERROR.NOT_FOUND, 404);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("merges details into response body", async () => {
    const res = errorResponse(API_ERROR.VALIDATION_ERROR, 400, {
      details: { fieldErrors: { title: ["required"] } },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.details.fieldErrors.title).toEqual(["required"]);
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
    const details = { fieldErrors: { email: ["invalid"] } };
    const res = validationError(details);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.details).toEqual(details);
  });
});
