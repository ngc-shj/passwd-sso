import { describe, it, expect } from "vitest";
import { isPasskeyRequiredResponse } from "../../lib/passkey-required";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("isPasskeyRequiredResponse", () => {
  it("matches a 403 whose error is PASSKEY_REQUIRED", async () => {
    expect(await isPasskeyRequiredResponse(jsonResponse({ error: "PASSKEY_REQUIRED" }, 403))).toBe(true);
  });

  it("leaves the original body readable for the caller", async () => {
    const res = jsonResponse({ error: "PASSKEY_REQUIRED" }, 403);
    await isPasskeyRequiredResponse(res);
    expect(await res.json()).toEqual({ error: "PASSKEY_REQUIRED" });
  });

  it("does not match a 403 with another error code", async () => {
    expect(await isPasskeyRequiredResponse(jsonResponse({ error: "FORBIDDEN" }, 403))).toBe(false);
  });

  it("does not match PASSKEY_REQUIRED under a status other than 403", async () => {
    expect(await isPasskeyRequiredResponse(jsonResponse({ error: "PASSKEY_REQUIRED" }, 401))).toBe(false);
  });

  it("returns false for a non-JSON body instead of throwing", async () => {
    expect(await isPasskeyRequiredResponse(new Response("<html>", { status: 403 }))).toBe(false);
  });

  it("returns false for an already-consumed body instead of throwing", async () => {
    const res = jsonResponse({ error: "PASSKEY_REQUIRED" }, 403);
    await res.text();
    expect(await isPasskeyRequiredResponse(res)).toBe(false);
  });
});
