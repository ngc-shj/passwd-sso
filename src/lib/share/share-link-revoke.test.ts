import { describe, it, expect } from "vitest";
import { revokeLeftLinkRevoked } from "./share-link-revoke";

const response = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("revokeLeftLinkRevoked", () => {
  it.each([
    ["a successful revoke", response(200, { ok: true }), true],
    ["ALREADY_REVOKED (revoked concurrently)", response(409, { error: "ALREADY_REVOKED" }), true],
    ["another refusal", response(404, { error: "NOT_FOUND" }), false],
    ["an error with no JSON body", response(500, undefined), false],
  ])("%s → %s", async (_label, res, want) => {
    expect(await revokeLeftLinkRevoked(res)).toBe(want);
  });
});
