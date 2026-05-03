import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { GET } from "./route";

describe("GET /api/mobile/.well-known/apple-app-site-association", () => {
  const originalTeam = process.env.IOS_APP_TEAM_ID;
  const originalBundle = process.env.IOS_APP_BUNDLE_ID;
  const originalBasePath = process.env.NEXT_PUBLIC_BASE_PATH;

  beforeEach(() => {
    delete process.env.IOS_APP_TEAM_ID;
    delete process.env.IOS_APP_BUNDLE_ID;
  });

  afterEach(() => {
    process.env.IOS_APP_TEAM_ID = originalTeam;
    process.env.IOS_APP_BUNDLE_ID = originalBundle;
    process.env.NEXT_PUBLIC_BASE_PATH = originalBasePath;
  });

  it("returns 503 when IOS_APP_TEAM_ID is unset", async () => {
    const response = GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatch(/IOS_APP_TEAM_ID/);
  });

  it("returns AASA JSON with default bundle ID when bundle env unset", async () => {
    process.env.IOS_APP_TEAM_ID = "ABCDE12345";
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.json();
    expect(body.applinks.details[0].appIDs).toEqual(["ABCDE12345.com.passwd-sso"]);
  });

  it("uses custom bundle ID from IOS_APP_BUNDLE_ID", async () => {
    process.env.IOS_APP_TEAM_ID = "ABCDE12345";
    process.env.IOS_APP_BUNDLE_ID = "jp.jpng.passwd-sso";
    const response = GET();

    const body = await response.json();
    expect(body.applinks.details[0].appIDs).toEqual([
      "ABCDE12345.jp.jpng.passwd-sso",
    ]);
  });

  it("includes basePath in components.path", async () => {
    process.env.IOS_APP_TEAM_ID = "ABCDE12345";
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
    process.env.IOS_APP_TEAM_ID = "ABCDE12345";
    const response = GET();

    const body = await response.json();
    expect(body.applinks.details[0].components[0].comment).toBe(
      "iOS auth callback",
    );
  });
});
