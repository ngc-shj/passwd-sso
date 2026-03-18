import { describe, it, expect } from "vitest";
import { sanitizeErrorForSentry } from "@/lib/sentry-sanitize";

describe("sanitizeErrorForSentry", () => {
  it("scrubs 64-char hex strings from error message", () => {
    const key = "a".repeat(64);
    const err = new Error(`invalid key: ${key}`);
    const sanitized = sanitizeErrorForSentry(err);
    expect(sanitized.message).not.toContain(key);
    expect(sanitized.message).toContain("[redacted-key]");
  });

  it("scrubs long base64 strings (>40 chars) from error message", () => {
    // 44-char base64 string (no spaces)
    const b64 = "dGhpcyBpcyBhIHZlcnkgbG9uZ2Jhc2U2NHN0cmluZw==";
    const err = new Error(`encoded: ${b64}`);
    const sanitized = sanitizeErrorForSentry(err);
    expect(sanitized.message).toContain("[redacted-b64]");
  });

  it("does not scrub short strings (<=40 chars base64-like)", () => {
    const short = "aGVsbG8gd29ybGQ="; // 16 chars, won't match >40
    const err = new Error(`token: ${short}`);
    const sanitized = sanitizeErrorForSentry(err);
    expect(sanitized.message).toContain(short);
  });

  it("recursively sanitizes error cause", () => {
    const key = "b".repeat(64);
    const cause = new Error(`cause with key: ${key}`);
    const err = new Error("outer error", { cause });
    const sanitized = sanitizeErrorForSentry(err);
    const sanitizedCause = sanitized.cause as Error;
    expect(sanitizedCause).toBeInstanceOf(Error);
    expect(sanitizedCause.message).not.toContain(key);
    expect(sanitizedCause.message).toContain("[redacted-key]");
  });

  it("strips Prisma meta field", () => {
    const err = new Error("Unique constraint failed") as Error & { meta?: unknown };
    err.meta = { target: ["email"], modelName: "User" };
    const sanitized = sanitizeErrorForSentry(err) as Error & { meta?: unknown };
    expect(sanitized.meta).toBeUndefined();
  });

  it("wraps non-Error input in a generic Error", () => {
    const sanitized = sanitizeErrorForSentry("string error");
    expect(sanitized).toBeInstanceOf(Error);
    expect(sanitized.message).toBe("string error");
  });

  it("wraps null input in a generic Error", () => {
    const sanitized = sanitizeErrorForSentry(null);
    expect(sanitized).toBeInstanceOf(Error);
    expect(sanitized.message).toBe("null");
  });

  it("preserves error name", () => {
    const err = new TypeError("bad type");
    const sanitized = sanitizeErrorForSentry(err);
    expect(sanitized.name).toBe("TypeError");
  });

  it("scrubs hex64 patterns from stack trace", () => {
    const key = "d".repeat(64);
    const err = new Error("test");
    err.stack = `Error: key=${key}\n    at Object.<anonymous> (test.ts:1:1)`;
    const sanitized = sanitizeErrorForSentry(err);
    expect(sanitized.stack).not.toContain(key);
    expect(sanitized.stack).toContain("[redacted-key]");
  });

  it("does not mutate the original error", () => {
    const key = "c".repeat(64);
    const err = new Error(`key: ${key}`);
    sanitizeErrorForSentry(err);
    expect(err.message).toContain(key);
  });
});
