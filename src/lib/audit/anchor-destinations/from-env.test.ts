import { describe, it, expect } from "vitest";
import { AnchorDestinationConfigError, buildDestinationsFromEnv } from "./from-env";
import { S3Destination } from "./s3-destination";
import { GitHubReleaseDestination } from "./github-release-destination";
import { FilesystemDestination } from "./filesystem-destination";

describe("buildDestinationsFromEnv", () => {
  it("orders the configured destinations S3, GitHub, filesystem — the first is the primary", () => {
    const destinations = buildDestinationsFromEnv({
      AUDIT_ANCHOR_DESTINATION_FS_PATH: "/var/anchors",
      AUDIT_ANCHOR_DESTINATION_GH_REPO: "owner/repo",
      AUDIT_ANCHOR_DESTINATION_GH_TOKEN: "ghp_xxx",
      AUDIT_ANCHOR_DESTINATION_S3_BUCKET: "anchors",
      AUDIT_ANCHOR_DESTINATION_S3_PREFIX: "audit-anchors",
    });

    expect(destinations.map((d) => d.name)).toEqual(["s3-object-lock", "github-release", "filesystem"]);
    expect(destinations[0]).toBeInstanceOf(S3Destination);
    expect(destinations[1]).toBeInstanceOf(GitHubReleaseDestination);
    expect(destinations[2]).toBeInstanceOf(FilesystemDestination);
    expect(destinations.map((d) => d.location)).toEqual([
      "s3://anchors/audit-anchors",
      "github://owner/repo",
      "file:///var/anchors",
    ]);
  });

  it.each([
    ["S3 alone, without a prefix", { AUDIT_ANCHOR_DESTINATION_S3_BUCKET: "anchors" }, ["s3-object-lock"]],
    ["the filesystem alone", { AUDIT_ANCHOR_DESTINATION_FS_PATH: "/var/anchors" }, ["filesystem"]],
    [
      "GitHub with its own token variable",
      { AUDIT_ANCHOR_DESTINATION_GH_REPO: "owner/repo", AUDIT_ANCHOR_DESTINATION_GH_TOKEN: "ghp_xxx" },
      ["github-release"],
    ],
    [
      "GitHub falling back to GITHUB_TOKEN",
      { AUDIT_ANCHOR_DESTINATION_GH_REPO: "owner/repo", GITHUB_TOKEN: "ghp_fallback" },
      ["github-release"],
    ],
  ])("builds %s", (_label, env, names) => {
    expect(buildDestinationsFromEnv(env).map((d) => d.name)).toEqual(names);
  });

  it("refuses a GitHub repository without any token, naming both variables", () => {
    expect(() =>
      buildDestinationsFromEnv({
        AUDIT_ANCHOR_DESTINATION_GH_REPO: "owner/repo",
        AUDIT_ANCHOR_DESTINATION_FS_PATH: "/var/anchors",
      }),
    ).toThrow(AnchorDestinationConfigError);
    expect(() => buildDestinationsFromEnv({ AUDIT_ANCHOR_DESTINATION_GH_REPO: "owner/repo" })).toThrow(
      /GITHUB_TOKEN or AUDIT_ANCHOR_DESTINATION_GH_TOKEN/,
    );
    expect(() => buildDestinationsFromEnv({ AUDIT_ANCHOR_DESTINATION_GH_REPO: "owner/repo" })).toThrow(
      expect.objectContaining({ code: "GITHUB_TOKEN_MISSING" }),
    );
  });

  it("refuses a relative filesystem path, whatever else is configured; the absolute path builds", () => {
    for (const relative of ["anchors", "./anchors", "../var/anchors"]) {
      const env = { AUDIT_ANCHOR_DESTINATION_S3_BUCKET: "anchors", AUDIT_ANCHOR_DESTINATION_FS_PATH: relative };
      expect(() => buildDestinationsFromEnv(env)).toThrow(AnchorDestinationConfigError);
      expect(() => buildDestinationsFromEnv(env)).toThrow(expect.objectContaining({ code: "FS_PATH_NOT_ABSOLUTE" }));
      // The message names the variable, never its value.
      expect(() => buildDestinationsFromEnv(env)).toThrow("AUDIT_ANCHOR_DESTINATION_FS_PATH must be an absolute path");
    }
    expect(
      buildDestinationsFromEnv({ AUDIT_ANCHOR_DESTINATION_FS_PATH: "/var/anchors" }).map((d) => d.location),
    ).toEqual(["file:///var/anchors"]);
  });

  it("gives one location to two spellings of one place", () => {
    const locationOf = (env: Parameters<typeof buildDestinationsFromEnv>[0]) => buildDestinationsFromEnv(env)[0]!.location;
    expect(locationOf({ AUDIT_ANCHOR_DESTINATION_FS_PATH: "/var/anchors/" })).toBe(
      locationOf({ AUDIT_ANCHOR_DESTINATION_FS_PATH: "/var/anchors" }),
    );
    const token = { AUDIT_ANCHOR_DESTINATION_GH_TOKEN: "ghp_xxx" };
    expect(locationOf({ AUDIT_ANCHOR_DESTINATION_GH_REPO: "Owner/Repo", ...token })).toBe(
      locationOf({ AUDIT_ANCHOR_DESTINATION_GH_REPO: "owner/repo", ...token }),
    );
    // Not every difference is spelling.
    expect(locationOf({ AUDIT_ANCHOR_DESTINATION_GH_REPO: "owner/other", ...token })).not.toBe(
      locationOf({ AUDIT_ANCHOR_DESTINATION_GH_REPO: "owner/repo", ...token }),
    );
  });

  it("refuses an env that configures no destination", () => {
    expect(() => buildDestinationsFromEnv({})).toThrow(AnchorDestinationConfigError);
    expect(() => buildDestinationsFromEnv({})).toThrow(expect.objectContaining({ code: "NO_DESTINATION_CONFIGURED" }));
    // A prefix or a token alone names no destination.
    expect(() =>
      buildDestinationsFromEnv({
        AUDIT_ANCHOR_DESTINATION_S3_PREFIX: "audit-anchors",
        AUDIT_ANCHOR_DESTINATION_GH_TOKEN: "ghp_xxx",
      }),
    ).toThrow(/No destinations configured/);
  });
});
