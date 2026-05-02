// @vitest-environment node
import { execSync } from "child_process";
import { describe, it, expect } from "vitest";
import { MS_PER_DAY } from "@/lib/constants/time";
import { BANNER_SUNSET_TS } from "./migration-banner-config";

const MIN_DAYS = 25;
const MAX_DAYS = 35;

describe("MigrationBanner freshness (CI only)", () => {
  it.skipIf(
    process.env.CI !== "true" || process.env.GITHUB_EVENT_NAME !== "pull_request",
  )(
    `BANNER_SUNSET_TS is ${MIN_DAYS}–${MAX_DAYS} days after the HEAD commit`,
    () => {
      const headIso = execSync("git log -1 --format=%cI HEAD").toString().trim();
      const headTs = new Date(headIso).getTime();
      const diffMs = BANNER_SUNSET_TS.getTime() - headTs;
      const diffDays = diffMs / MS_PER_DAY;

      expect(diffDays).toBeGreaterThanOrEqual(MIN_DAYS);
      expect(diffDays).toBeLessThanOrEqual(MAX_DAYS);
    },
  );
});
