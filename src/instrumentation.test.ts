import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mocks
const mocks = vi.hoisted(() => ({
  captureRequestError: vi.fn(),
  sanitizeErrorForSentry: vi.fn((err: unknown) => err),
}));

vi.mock("@sentry/nextjs", () => ({
  captureRequestError: mocks.captureRequestError,
}));

vi.mock("@/lib/sentry-sanitize", () => ({
  sanitizeErrorForSentry: mocks.sanitizeErrorForSentry,
}));

// Dynamic import to avoid module-level side effects
async function loadOnRequestError() {
  const mod = await import("./instrumentation");
  return mod.onRequestError;
}

// Minimal mock request/context matching Next.js InstrumentationOnRequestError signature
function makeMockArgs(err: unknown) {
  const request = {
    method: "GET",
    url: "http://localhost/api/test",
    headers: new Headers(),
  };
  const context = { routerKind: "App Router" as const, routePath: "/api/test", routeType: "route" as const, renderSource: "react-server-components" as const, revalidateReason: undefined };
  return [err, request, context] as const;
}

describe("onRequestError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not call captureRequestError when SENTRY_DSN is not set", async () => {
    const origDsn = process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN;

    const onRequestError = await loadOnRequestError();
    const err = new Error("test error");
    await onRequestError(...makeMockArgs(err));

    expect(mocks.captureRequestError).not.toHaveBeenCalled();

    if (origDsn) process.env.SENTRY_DSN = origDsn;
  });

  it("sanitizes Error before passing to captureRequestError", async () => {
    const origDsn = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://fake@sentry.io/123";

    const sanitizedError = new Error("sanitized");
    mocks.sanitizeErrorForSentry.mockReturnValue(sanitizedError);

    const onRequestError = await loadOnRequestError();
    const originalError = new Error("has secret key " + "a".repeat(64));
    await onRequestError(...makeMockArgs(originalError));

    expect(mocks.sanitizeErrorForSentry).toHaveBeenCalledWith(originalError);
    expect(mocks.captureRequestError).toHaveBeenCalledWith(
      sanitizedError,
      expect.anything(),
      expect.anything(),
    );

    process.env.SENTRY_DSN = origDsn;
  });

  it("passes non-Error values through without sanitization", async () => {
    const origDsn = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://fake@sentry.io/123";

    const onRequestError = await loadOnRequestError();
    await onRequestError(...makeMockArgs("string error"));

    expect(mocks.sanitizeErrorForSentry).not.toHaveBeenCalled();
    expect(mocks.captureRequestError).toHaveBeenCalledWith(
      "string error",
      expect.anything(),
      expect.anything(),
    );

    process.env.SENTRY_DSN = origDsn;
  });
});
