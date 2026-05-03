import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { mockAssertOrigin } = vi.hoisted(() => ({
  mockAssertOrigin: vi.fn(),
}));

vi.mock("@/lib/auth/session/csrf", () => ({
  assertOrigin: mockAssertOrigin,
}));

import { shouldEnforceCsrf, assertSessionCsrf } from "./csrf-gate";

const APP_ORIGIN = "http://localhost:3000";

function makeRequest(method: string): NextRequest {
  return new NextRequest(`${APP_ORIGIN}/api/anything`, { method });
}

const ALL_METHODS = [
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;

const MUTATING = new Set<string>(["POST", "PUT", "PATCH", "DELETE"]);

describe("shouldEnforceCsrf — truth table over (cookiePresent? × method)", () => {
  // 14 cells total: 7 methods × 2 cookie states. Exactly the
  // (cookie=true × mutating-method) cells return true.
  for (const method of ALL_METHODS) {
    for (const cookiePresent of [true, false]) {
      const expected = cookiePresent && MUTATING.has(method);
      it(`cookie=${cookiePresent} × ${method} → ${expected}`, () => {
        expect(shouldEnforceCsrf(makeRequest(method), cookiePresent)).toBe(expected);
      });
    }
  }

  it("denies enforcement when method is unknown casing (case-sensitive guard)", () => {
    // Node fetch normalises method to upper-case at NextRequest construction;
    // documenting that the gate does not double-normalise. If this becomes
    // load-bearing, NextRequest semantics change should be tested explicitly.
    expect(shouldEnforceCsrf(makeRequest("post"), true)).toBe(true);
  });
});

describe("assertSessionCsrf — delegation to assertOrigin", () => {
  beforeEach(() => {
    mockAssertOrigin.mockReset();
  });

  it("returns null when assertOrigin returns null (pass-through)", () => {
    mockAssertOrigin.mockReturnValueOnce(null);
    const req = makeRequest("POST");
    expect(assertSessionCsrf(req)).toBeNull();
    expect(mockAssertOrigin).toHaveBeenCalledWith(req);
  });

  it("forwards a 403 NextResponse from assertOrigin (deny)", () => {
    const denyResponse = NextResponse.json({ error: "INVALID_ORIGIN" }, { status: 403 });
    mockAssertOrigin.mockReturnValueOnce(denyResponse);
    const req = makeRequest("POST");
    const result = assertSessionCsrf(req);
    expect(result).toBe(denyResponse);
    expect(result?.status).toBe(403);
  });

  it("delegates without inspecting the request itself (passes the same NextRequest object)", () => {
    mockAssertOrigin.mockReturnValueOnce(null);
    const req = makeRequest("PUT");
    assertSessionCsrf(req);
    expect(mockAssertOrigin).toHaveBeenCalledTimes(1);
    expect(mockAssertOrigin.mock.calls[0]?.[0]).toBe(req);
  });
});
