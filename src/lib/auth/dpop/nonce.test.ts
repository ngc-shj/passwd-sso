import { describe, it, expect, vi, beforeEach } from "vitest";

// Force the in-memory fallback path: getRedis() returns null. The test then
// drives the deterministic memory branch via the injectable `now()` clock.
vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
}));

import {
  createDpopNonceService,
  getDpopNonceService,
  _resetDpopNonceServiceForTests,
} from "./nonce";

beforeEach(() => {
  _resetDpopNonceServiceForTests();
});

describe("createDpopNonceService — in-memory fallback", () => {
  it("emits a base64url-shaped nonce on first call", async () => {
    const svc = createDpopNonceService();
    const cur = await svc.current();
    // 24 bytes → 32 base64url chars, no padding, no +//= chars.
    expect(cur).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("returns the same nonce across consecutive current() calls before rotation is due", async () => {
    let fakeNow = 1_000_000;
    const svc = createDpopNonceService({ rotationMs: 1_000, now: () => fakeNow });
    const a = await svc.current();
    fakeNow += 500; // still inside rotation window
    await svc.rotateIfDue();
    const b = await svc.current();
    expect(b).toBe(a);
  });

  it("rotates the nonce after the rotation window elapses", async () => {
    let fakeNow = 1_000_000;
    const svc = createDpopNonceService({ rotationMs: 1_000, now: () => fakeNow });
    const a = await svc.current();
    fakeNow += 1_500; // past rotation window
    await svc.rotateIfDue();
    const b = await svc.current();
    expect(b).not.toBe(a);
    expect(b).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("does not rotate on rotateIfDue when freshness window has not elapsed (boundary just-before)", async () => {
    let fakeNow = 1_000_000;
    const svc = createDpopNonceService({ rotationMs: 1_000, now: () => fakeNow });
    const a = await svc.current();
    fakeNow += 999; // 1 ms shy of the boundary
    await svc.rotateIfDue();
    expect(await svc.current()).toBe(a);
  });

  it("rotates exactly at the rotationMs boundary (>=, not >)", async () => {
    let fakeNow = 1_000_000;
    const svc = createDpopNonceService({ rotationMs: 1_000, now: () => fakeNow });
    const a = await svc.current();
    fakeNow += 1_000; // exactly at boundary
    await svc.rotateIfDue();
    const b = await svc.current();
    expect(b).not.toBe(a);
  });

  it("two services start with independent nonces (no shared mutable state)", async () => {
    const a = await createDpopNonceService().current();
    const b = await createDpopNonceService().current();
    expect(a).not.toBe(b);
  });
});

describe("getDpopNonceService — singleton lifecycle", () => {
  it("returns the same instance across calls", () => {
    const a = getDpopNonceService();
    const b = getDpopNonceService();
    expect(a).toBe(b);
  });

  it("returns a fresh instance after _resetDpopNonceServiceForTests()", () => {
    const a = getDpopNonceService();
    _resetDpopNonceServiceForTests();
    const b = getDpopNonceService();
    expect(b).not.toBe(a);
  });
});
