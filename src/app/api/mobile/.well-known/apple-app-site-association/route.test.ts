import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/mobile/.well-known/apple-app-site-association", () => {
  beforeEach(() => {
    // Assert the precondition instead of inheriting an ambient absence: the
    // 503 case below is only meaningful when the var really is unset, and an
    // environment that supplies it (a CI job-level env block, an operator's
    // .env) would otherwise turn that case green for the wrong reason —
    // round-1 CR1. "" is falsy at the route's read site, so it is a faithful
    // "unset"; setup.ts's afterEach (vi.unstubAllEnvs()) reverts it.
    vi.stubEnv("IOS_APP_TEAM_ID", "");
    // Same reasoning for the bundle id: the default-bundle case below asserts
    // what the route falls back to when it is unset. The route reads it with
    // `||`, so "" takes the fallback exactly as an unset var does.
    vi.stubEnv("IOS_APP_BUNDLE_ID", "");
  });

  it("returns 503 when IOS_APP_TEAM_ID is unset", async () => {
    const response = GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatch(/IOS_APP_TEAM_ID/);
  });

  it("returns AASA JSON with default bundle ID when bundle env unset", async () => {
    vi.stubEnv("IOS_APP_TEAM_ID", "ABCDE12345");
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.json();
    // The default must equal the bundle id ios/project.yml actually ships
    // (PRODUCT_BUNDLE_IDENTIFIER of the PasswdSSOApp target). A mismatch here
    // means the published AASA claims an appID no installed app owns, and
    // Universal Links silently fail to associate.
    expect(body.applinks.details[0].appIDs).toEqual(["ABCDE12345.jp.jpng.passwd-sso"]);
  });

  it("uses custom bundle ID from IOS_APP_BUNDLE_ID", async () => {
    vi.stubEnv("IOS_APP_TEAM_ID", "ABCDE12345");
    // Deliberately NOT the default: an override fixture equal to the default
    // cannot distinguish "the env var was honoured" from "the default was used".
    vi.stubEnv("IOS_APP_BUNDLE_ID", "jp.jpng.passwd-sso.enterprise");
    const response = GET();

    const body = await response.json();
    expect(body.applinks.details[0].appIDs).toEqual([
      "ABCDE12345.jp.jpng.passwd-sso.enterprise",
    ]);
  });

  it("includes basePath in components.path", async () => {
    vi.stubEnv("IOS_APP_TEAM_ID", "ABCDE12345");
    // BASE_PATH is captured at module import time; this test asserts the
    // current behavior given the import-time value (typically "" in tests).
    const response = GET();
    const body = await response.json();
    const path = body.applinks.details[0].components[0]["/"];
    // Either "/api/mobile/authorize/redirect" (no basePath in test env)
    // or "<basePath>/api/mobile/authorize/redirect" (basePath set).
    expect(path).toMatch(/\/api\/mobile\/authorize\/redirect$/);
  });

  it("includes the iOS auth callback comment", async () => {
    vi.stubEnv("IOS_APP_TEAM_ID", "ABCDE12345");
    const response = GET();

    const body = await response.json();
    expect(body.applinks.details[0].components[0].comment).toBe(
      "iOS auth callback",
    );
  });
});
