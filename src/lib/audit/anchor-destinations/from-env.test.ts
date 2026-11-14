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
