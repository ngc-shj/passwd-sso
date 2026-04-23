/**
 * Tests for callbackUrlToHref with non-empty BASE_PATH.
 * Separated because BASE_PATH is a module-level constant
 * that must be mocked before import.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("./url-helpers", () => ({
  BASE_PATH: "/passwd-sso",
}));

import { callbackUrlToHref } from "./auth/session/callback-url";

describe("callbackUrlToHref (BASE_PATH=/passwd-sso)", () => {
  it("strips basePath and locale prefix", () => {
    expect(callbackUrlToHref("/passwd-sso/ja/dashboard?ext_connect=1")).toBe(
      "/dashboard?ext_connect=1",
    );
  });

  it("strips basePath without locale", () => {
    expect(callbackUrlToHref("/passwd-sso/dashboard")).toBe("/dashboard");
  });

  it("returns / when path equals basePath", () => {
    expect(callbackUrlToHref("/passwd-sso")).toBe("/");
  });

  it("does not strip when path does not start with basePath", () => {
    expect(callbackUrlToHref("/other/ja/dashboard")).toBe("/other/ja/dashboard");
  });
});
