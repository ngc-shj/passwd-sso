import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

// A04-4: the legacy single-actor endpoint returns 410 Gone with a body that
// points operators at the new dual-approval endpoints. No auth, no rate limit,
// no DB writes — the only correct response is the discovery payload.
describe("POST /api/admin/rotate-master-key (legacy, 410 Gone)", () => {
  it("returns 410 with replacedBy discovery payload regardless of auth", async () => {
    const req = new NextRequest("http://localhost/api/admin/rotate-master-key", {
      method: "POST",
      body: JSON.stringify({ targetVersion: 2 }),
      headers: { "content-type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBe("MASTER_KEY_ROTATION_LEGACY_GONE");
    expect(body.replacedBy).toEqual({
      initiate: "/api/admin/rotate-master-key/initiate",
      approve: "/api/admin/rotate-master-key/[rotationId]/approve",
      execute: "/api/admin/rotate-master-key/[rotationId]/execute",
      revoke: "/api/admin/rotate-master-key/[rotationId]/revoke",
    });
  });

  it("does not mutate PasswordShare (no destructive side-effect)", async () => {
    // The route's source is grep-checked by pre-pr.sh guard
    // master-key-rotation-legacy-endpoint-gone: any `passwordShare.updateMany`
    // string in the file fails the guard. Mirror the assertion in the test so
    // the regression is caught here too.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("./route.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/passwordShare\.updateMany/);
  });
});
