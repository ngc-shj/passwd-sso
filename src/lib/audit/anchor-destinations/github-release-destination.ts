import { MS_PER_MINUTE } from "@/lib/constants/time";
import {
  assertAnchorArtifactKey,
  InvalidArtifactKeyError,
  parseManifestArtifactKey,
} from "@/lib/audit/anchor-artifact-keys";
import { assertArtifactSize, type AnchorDestination } from "./destination";

type GitHubConfig = {
  repo: string;
  token: string;
  /** Default: https://api.github.com. */
  apiBaseUrl?: string;
  /** Releases per listing page. Default: the API's maximum. */
  listPageSize?: number;
};

type GitHubAsset = {
  id: number;
  name: string;
  state: string;
  size: number;
  created_at: string;
};

type GitHubRelease = {
  id: number;
  tag_name: string;
  upload_url: string;
  assets?: GitHubAsset[];
};

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_RELEASES_PAGE_SIZE = 100;
// The only state in which an asset holds content. Any other is a name held by
// an upload that has not finished, or never will.
const ASSET_STATE_UPLOADED = "uploaded";

const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;

const RELEASE_TAG_PREFIX = "audit-anchor-";
const PUBLIC_KEYS_TAG = `${RELEASE_TAG_PREFIX}public-keys`;
const KEY_ROTATION_TAG = `${RELEASE_TAG_PREFIX}key-rotation`;
const PUBLIC_KEYS_DIR = "public-keys/";

/**
 * How long a name reservation without content is left alone: above any upload
 * bound, so a reservation older than this belongs to no upload still running.
 */
export const GITHUB_ASSET_RESERVATION_STALE_MS = 10 * MS_PER_MINUTE;

/** A GitHub API answer the destination does not accept. Its `code` is what a failure reason carries. */
export class GitHubRequestError extends Error {
  readonly code: string;
  constructor(operation: string, readonly status: number) {
    super(`GitHubReleaseDestination: ${operation}: HTTP ${status}`);
    this.name = "GitHubRequestError";
    this.code = `HTTP_${status}`;
  }
}

/** The asset name is held by an upload that may still be running. */
export class GitHubAssetReservedError extends Error {
  readonly code = "ASSET_NAME_RESERVED";
  constructor() {
    super("GitHubReleaseDestination: the asset name is reserved by an unfinished upload");
    this.name = "GitHubAssetReservedError";
  }
}

/** The release tag and asset name an artifact key is stored under. */
export function githubLocationForKey(artifactKey: string): { tag: string; assetName: string } {
  assertAnchorArtifactKey(artifactKey);
  const manifest = parseManifestArtifactKey(artifactKey);
  if (manifest) return { tag: `${RELEASE_TAG_PREFIX}${manifest.date}`, assetName: artifactKey };
  if (artifactKey.startsWith(PUBLIC_KEYS_DIR)) {
    return { tag: PUBLIC_KEYS_TAG, assetName: artifactKey.slice(PUBLIC_KEYS_DIR.length) };
  }
  return { tag: KEY_ROTATION_TAG, assetName: artifactKey };
}

/** The inverse of githubLocationForKey; null for a release that is not an anchor one. */
export function keyForGithubAsset(tag: string, assetName: string): string | null {
  if (!tag.startsWith(RELEASE_TAG_PREFIX)) return null;
  return tag === PUBLIC_KEYS_TAG ? `${PUBLIC_KEYS_DIR}${assetName}` : assetName;
}

/**
 * The key of an asset that `read` and `create` would find where it sits: one
 * whose own location is this tag and name. An asset under another tag (a
 * manifest under another date's release, or under the key-rotation one) is
 * not a stored object, so it is not listed.
 */
function storedKeyForAsset(tag: string, assetName: string): string | null {
  const key = keyForGithubAsset(tag, assetName);
  if (key === null) return null;
  try {
    const location = githubLocationForKey(key);
    return location.tag === tag && location.assetName === assetName ? key : null;
  } catch (err) {
    if (err instanceof InvalidArtifactKeyError) return null;
    throw err;
  }
}

export class GitHubReleaseDestination implements AnchorDestination {
  readonly name = "github-release";

  private readonly apiBase: string;
  private readonly token: string;
  private readonly listPageSize: number;

  constructor(config: GitHubConfig) {
    if (!config.token) {
      throw new Error(
        "GitHubReleaseDestination: token is required. Set GITHUB_TOKEN or AUDIT_ANCHOR_DESTINATION_GH_TOKEN.",
      );
    }
    this.apiBase = `${config.apiBaseUrl ?? GITHUB_API_BASE_URL}/repos/${config.repo}`;
    this.token = config.token;
    this.listPageSize = config.listPageSize ?? GITHUB_RELEASES_PAGE_SIZE;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `token ${this.token}`,
      Accept: "application/vnd.github+json",
      ...extra,
    };
  }

  private async releaseByTag(tag: string, signal?: AbortSignal): Promise<GitHubRelease | null> {
    const res = await fetch(`${this.apiBase}/releases/tags/${tag}`, { headers: this.headers(), signal });
    if (res.status === HTTP_NOT_FOUND) return null;
    if (!res.ok) throw new GitHubRequestError(`fetch release ${tag}`, res.status);
    return (await res.json()) as GitHubRelease;
  }

  private async getOrCreateRelease(tag: string, signal?: AbortSignal): Promise<GitHubRelease> {
    const createRes = await fetch(`${this.apiBase}/releases`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        tag_name: tag,
        name: tag.slice(RELEASE_TAG_PREFIX.length),
        draft: false,
        prerelease: false,
      }),
      signal,
    });

    if (createRes.ok) {
      return (await createRes.json()) as GitHubRelease;
    }

    if (createRes.status === HTTP_UNPROCESSABLE) {
      // Release already exists — fetch it
      const existing = await this.releaseByTag(tag, signal);
      if (!existing) throw new GitHubRequestError(`fetch existing release ${tag}`, HTTP_NOT_FOUND);
      return existing;
    }

    throw new GitHubRequestError(`create release ${tag}`, createRes.status);
  }

  private async uploadAsset(
    release: GitHubRelease,
    assetName: string,
    args: { artifactBytes: Buffer; contentType: string; signal?: AbortSignal },
  ): Promise<Response> {
    // upload_url is a URI template like: https://uploads.github.com/repos/.../releases/123/assets{?name,label}
    const uploadBase = release.upload_url.replace(/\{[^}]+\}/, "");
    return fetch(`${uploadBase}?name=${encodeURIComponent(assetName)}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": args.contentType }),
      // Convert Buffer (whose .buffer is ArrayBufferLike, not ArrayBuffer per
      // current TS lib.dom narrowing) to a freshly-allocated ArrayBuffer-backed
      // Uint8Array so fetch BodyInit type matches.
      body: new Uint8Array(args.artifactBytes),
      signal: args.signal,
    });
  }

  /** The asset as the API holds it now, or null when it is gone. */
  private async assetById(id: number, signal?: AbortSignal): Promise<GitHubAsset | null> {
    const res = await fetch(`${this.apiBase}/releases/assets/${id}`, { headers: this.headers(), signal });
    if (res.status === HTTP_NOT_FOUND) return null;
    if (!res.ok) throw new GitHubRequestError(`fetch asset ${id}`, res.status);
    return (await res.json()) as GitHubAsset;
  }

  /**
   * Remove an asset that reserves a name without content. The only delete this
   * destination makes: an `uploaded` asset is a stored artifact and never
   * reaches it.
   */
  private async deleteAssetReservation(asset: GitHubAsset, signal?: AbortSignal): Promise<void> {
    if (asset.state === ASSET_STATE_UPLOADED) {
      throw new Error("GitHubReleaseDestination: refusing to delete an uploaded asset");
    }
    const res = await fetch(`${this.apiBase}/releases/assets/${asset.id}`, {
      method: "DELETE",
      headers: this.headers(),
      signal,
    });
    if (!res.ok) throw new GitHubRequestError(`delete asset reservation ${asset.id}`, res.status);
  }

  async create(args: {
    artifactBytes: Buffer;
    artifactKey: string;
    contentType: string;
    signal?: AbortSignal;
  }): Promise<"created" | "exists"> {
    const { artifactKey, signal } = args;
    const { tag, assetName } = githubLocationForKey(artifactKey);
    assertArtifactSize(args.artifactBytes.length);

    const release = await this.getOrCreateRelease(tag, signal);
    const first = await this.uploadAsset(release, assetName, args);
    if (first.ok) return "created";
    if (first.status !== HTTP_UNPROCESSABLE) throw new GitHubRequestError(`upload asset ${artifactKey}`, first.status);

    // A 422 is a taken name only when an asset holds it; the body is not read.
    const holder = (await this.releaseByTag(tag, signal))?.assets?.find((a) => a.name === assetName);
    if (!holder) throw new GitHubRequestError(`upload asset ${artifactKey}`, first.status);
    if (holder.state === ASSET_STATE_UPLOADED) return "exists";

    // A reservation without content. A young one may be another writer
    // mid-upload; an unreadable age counts as young.
    const ageMs = Date.now() - Date.parse(holder.created_at);
    if (!(ageMs > GITHUB_ASSET_RESERVATION_STALE_MS)) throw new GitHubAssetReservedError();

    // Read once more: the upload may have finished since the first look.
    // Between this read and the delete it still can — the API offers no
    // conditional delete, so that window stays open.
    const current = await this.assetById(holder.id, signal);
    if (current?.state === ASSET_STATE_UPLOADED) return "exists";
    if (current) await this.deleteAssetReservation(current, signal);

    const second = await this.uploadAsset(release, assetName, args);
    if (second.ok) return "created";
    throw new GitHubRequestError(`upload asset ${artifactKey}`, second.status);
  }

  async read(artifactKey: string, signal?: AbortSignal): Promise<Buffer | null> {
    const { tag, assetName } = githubLocationForKey(artifactKey);
    const release = await this.releaseByTag(tag, signal);
    const asset = release?.assets?.find((a) => a.name === assetName && a.state === ASSET_STATE_UPLOADED);
    if (!asset) return null;
    assertArtifactSize(asset.size);

    const res = await fetch(`${this.apiBase}/releases/assets/${asset.id}`, {
      headers: this.headers({ Accept: "application/octet-stream" }),
      signal,
    });
    if (!res.ok) throw new GitHubRequestError(`download asset ${artifactKey}`, res.status);
    const bytes = Buffer.from(await res.arrayBuffer());
    assertArtifactSize(bytes.length);
    return bytes;
  }

  async list(signal?: AbortSignal): Promise<string[]> {
    const keys: string[] = [];
    for (let page = 1; ; page++) {
      const res = await fetch(`${this.apiBase}/releases?per_page=${this.listPageSize}&page=${page}`, {
        headers: this.headers(),
        signal,
      });
      if (!res.ok) throw new GitHubRequestError("list releases", res.status);
      const releases = (await res.json()) as GitHubRelease[];
      for (const release of releases) {
        for (const asset of release.assets ?? []) {
          if (asset.state !== ASSET_STATE_UPLOADED) continue;
          const key = storedKeyForAsset(release.tag_name, asset.name);
          if (key !== null) keys.push(key);
        }
      }
      if (releases.length < this.listPageSize) return keys;
    }
  }
}
