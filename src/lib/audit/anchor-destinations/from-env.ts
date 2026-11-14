import type { AnchorDestination } from "./destination";
import { S3Destination } from "./s3-destination";
import { GitHubReleaseDestination } from "./github-release-destination";
import { FilesystemDestination } from "./filesystem-destination";

/** The destination variables, as the worker env schema parsed them. */
export type AnchorDestinationEnv = {
  AUDIT_ANCHOR_DESTINATION_S3_BUCKET?: string;
  AUDIT_ANCHOR_DESTINATION_S3_PREFIX?: string;
  AUDIT_ANCHOR_DESTINATION_GH_REPO?: string;
  AUDIT_ANCHOR_DESTINATION_GH_TOKEN?: string;
  AUDIT_ANCHOR_DESTINATION_FS_PATH?: string;
  /** Fallback for the GitHub destination's token. */
  GITHUB_TOKEN?: string;
};

export const ANCHOR_DESTINATION_CONFIG_ERROR = {
  GITHUB_TOKEN_MISSING: "GITHUB_TOKEN_MISSING",
  NO_DESTINATION_CONFIGURED: "NO_DESTINATION_CONFIGURED",
} as const;

export type AnchorDestinationConfigErrorCode =
  (typeof ANCHOR_DESTINATION_CONFIG_ERROR)[keyof typeof ANCHOR_DESTINATION_CONFIG_ERROR];

/**
 * The destination variables do not describe a usable set. The message names
 * variables, never values; `code` is what a boot log line carries.
 */
export class AnchorDestinationConfigError extends Error {
  constructor(
    readonly code: AnchorDestinationConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AnchorDestinationConfigError";
  }
}

/**
 * The configured destinations, in the order that makes the first one the
 * primary: S3, else GitHub, else filesystem. Reads nothing but `env` and
 * performs no I/O.
 */
export function buildDestinationsFromEnv(env: AnchorDestinationEnv): AnchorDestination[] {
  const destinations: AnchorDestination[] = [];

  if (env.AUDIT_ANCHOR_DESTINATION_S3_BUCKET) {
    destinations.push(
      new S3Destination({
        bucket: env.AUDIT_ANCHOR_DESTINATION_S3_BUCKET,
        prefix: env.AUDIT_ANCHOR_DESTINATION_S3_PREFIX ?? "",
      }),
    );
  }

  if (env.AUDIT_ANCHOR_DESTINATION_GH_REPO) {
    const token = env.AUDIT_ANCHOR_DESTINATION_GH_TOKEN ?? env.GITHUB_TOKEN;
    if (!token) {
      throw new AnchorDestinationConfigError(
        ANCHOR_DESTINATION_CONFIG_ERROR.GITHUB_TOKEN_MISSING,
        "GITHUB_TOKEN or AUDIT_ANCHOR_DESTINATION_GH_TOKEN is required for GitHub release destination",
      );
    }
    destinations.push(new GitHubReleaseDestination({ repo: env.AUDIT_ANCHOR_DESTINATION_GH_REPO, token }));
  }

  if (env.AUDIT_ANCHOR_DESTINATION_FS_PATH) {
    destinations.push(new FilesystemDestination({ basePath: env.AUDIT_ANCHOR_DESTINATION_FS_PATH }));
  }

  if (destinations.length === 0) {
    throw new AnchorDestinationConfigError(
      ANCHOR_DESTINATION_CONFIG_ERROR.NO_DESTINATION_CONFIGURED,
      "No destinations configured. Set at least one of: AUDIT_ANCHOR_DESTINATION_S3_BUCKET, AUDIT_ANCHOR_DESTINATION_GH_REPO, AUDIT_ANCHOR_DESTINATION_FS_PATH",
    );
  }

  return destinations;
}
