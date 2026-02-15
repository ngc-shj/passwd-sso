import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /api/health/live", () => {
  it("returns 200 with alive status", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "alive" });
  });

  it("sets Cache-Control: no-store header", () => {
    const res = GET();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 200 regardless of external dependencies", async () => {
    // Liveness endpoint never checks DB/Redis, so it always returns 200.
    // This test verifies no imports of prisma/redis cause runtime failure.
    const res = GET();
    expect(res.status).toBe(200);
  });
});
