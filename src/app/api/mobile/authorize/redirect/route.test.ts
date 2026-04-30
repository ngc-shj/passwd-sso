import { describe, it, expect, vi } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────
//
// The route does not import @/lib/prisma, but we still mock it so we can
// assert no DB access occurred during the request lifecycle.

const { mockPrismaProxy } = vi.hoisted(() => ({
  mockPrismaProxy: new Proxy(
    {},
    {
      get() {
        throw new Error("redirect route must not access prisma");
      },
    },
  ),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrismaProxy }));

import { GET } from "./route";

describe("GET /api/mobile/authorize/redirect", () => {
  it("returns 200 with a static HTML fallback page", async () => {
    const url =
      "https://example.test/api/mobile/authorize/redirect?code=abc&state=xyz";
    const res = await GET(createRequest("GET", url));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Sign-in complete");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not access the database (Proxy mock would throw)", async () => {
    const url =
      "https://example.test/api/mobile/authorize/redirect?code=abc&state=xyz";
    // If the handler ever touches prisma.<anything>, the Proxy throws and
    // the test fails. Reaching status=200 proves no DB access.
    const res = await GET(createRequest("GET", url));
    expect(res.status).toBe(200);
  });
});
