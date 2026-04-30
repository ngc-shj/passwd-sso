import type { AnchorDestination } from "./destination";

type GitHubConfig = {
  repo: string;
  token: string;
};

type GitHubRelease = {
  id: number;
  upload_url: string;
};

export class GitHubReleaseDestination implements AnchorDestination {
  readonly name = "github-release";

  private readonly repo: string;
  private readonly token: string;

  constructor(config: GitHubConfig) {
    if (!config.token) {
      throw new Error(
        "GitHubReleaseDestination: token is required. Set GITHUB_TOKEN or AUDIT_ANCHOR_DESTINATION_GH_TOKEN.",
      );
    }
    this.repo = config.repo;
    this.token = config.token;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `token ${this.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };
  }

  private tagForDate(artifactKey: string): string {
    // artifactKey is like "2026-05-02.kid-audit-anchor-abc.jws"
    const datePart = artifactKey.split(".")[0];
    return `audit-anchor-${datePart ?? artifactKey}`;
  }

  private async getOrCreateRelease(tag: string, date: string): Promise<GitHubRelease> {
    const apiBase = `https://api.github.com/repos/${this.repo}`;

    const createRes = await fetch(`${apiBase}/releases`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        tag_name: tag,
        name: date,
        draft: false,
        prerelease: false,
      }),
    });

    if (createRes.ok) {
      return createRes.json() as Promise<GitHubRelease>;
    }

    if (createRes.status === 422) {
      // Release already exists — fetch it
      const getRes = await fetch(`${apiBase}/releases/tags/${tag}`, {
        headers: this.headers,
      });
      if (!getRes.ok) {
        throw new Error(
          `GitHubReleaseDestination: failed to fetch existing release for tag ${tag}: HTTP ${getRes.status}`,
        );
      }
      return getRes.json() as Promise<GitHubRelease>;
    }

    throw new Error(
      `GitHubReleaseDestination: failed to create release for tag ${tag}: HTTP ${createRes.status}`,
    );
  }

  async upload(args: {
    artifactBytes: Buffer;
    artifactKey: string;
    contentType: string;
  }): Promise<void> {
    const { artifactBytes, artifactKey, contentType } = args;

    const datePart = artifactKey.split(".")[0] ?? artifactKey;
    const tag = this.tagForDate(artifactKey);

    const release = await this.getOrCreateRelease(tag, datePart);

    // upload_url is a URI template like: https://uploads.github.com/repos/.../releases/123/assets{?name,label}
    const uploadBase = release.upload_url.replace(/\{[^}]+\}/, "");
    const uploadUrl = `${uploadBase}?name=${encodeURIComponent(artifactKey)}`;

    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `token ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": contentType,
      },
      body: artifactBytes,
    });

    if (!uploadRes.ok) {
      throw new Error(
        `GitHubReleaseDestination: failed to upload asset ${artifactKey}: HTTP ${uploadRes.status}`,
      );
    }
  }
}
