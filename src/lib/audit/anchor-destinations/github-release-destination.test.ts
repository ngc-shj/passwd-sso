import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GitHubReleaseDestination,
  GitHubRequestError,
  githubLocationForKey,
  keyForGithubAsset,
} from "./github-release-destination";
import {
  ANCHOR_ARTIFACT_CONTENT_TYPE,
  InvalidArtifactKeyError,
  STATEMENT_OP,
  publicKeyArtifactKey,
  statementArtifactKey,
} from "@/lib/audit/anchor-artifact-keys";

// The API's answers to a taken name, the listing and the contract suite run
// against a fake server in audit-anchor-github-release-destination.integration.test.ts.
// Here: what the destination sends, and the key ↔ (tag, asset name) pair.

// boundary: mocking global fetch (module uses fetch directly, not @octokit/rest)
const fetchSpy = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchSpy.mockReset();
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeOkResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeErrorResponse(status: number): Response {
  return new Response("err", { status });
}

const KID = "audit-anchor-0123456789abcdef";
const MANIFEST_KEY = `2026-05-02.kid-${KID}.jws`;
const RELEASE = {
  id: 123,
  tag_name: "audit-anchor-2026-05-02",
  upload_url: "https://uploads.github.com/repos/owner/repo/releases/123/assets{?name,label}",
  assets: [],
};

function createManifest(dest: GitHubReleaseDestination, signal?: AbortSignal) {
  return dest.create({
    artifactBytes: Buffer.from("jws-payload"),
    artifactKey: MANIFEST_KEY,
    contentType: ANCHOR_ARTIFACT_CONTENT_TYPE.JWS,
    signal,
  });
}

describe("GitHubReleaseDestination — constructor", () => {
  it("requires token", () => {
    expect(() => new GitHubReleaseDestination({ repo: "owner/repo", token: "" })).toThrow(
      /token is required/,
    );
  });

  it("has name 'github-release'", () => {
    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    expect(dest.name).toBe("github-release");
  });

  it("names the repository as its location, whatever the API base", () => {
    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    const elsewhere = new GitHubReleaseDestination({
      repo: "owner/other",
      token: "ghp_xxx",
      apiBaseUrl: "http://127.0.0.1:9",
    });

    expect(dest.location).toBe("github://owner/repo");
    expect(elsewhere.location).toBe("github://owner/other");
  });
});

describe("githubLocationForKey / keyForGithubAsset", () => {
  const day = new Date("2026-05-03T12:00:00.000Z");
  const rotation = statementArtifactKey(day, STATEMENT_OP.ROTATION, KID);
  const restart = statementArtifactKey(day, STATEMENT_OP.CHAIN_RESTART, KID);

  it.each([
    ["a manifest, under its date's release", MANIFEST_KEY, "audit-anchor-2026-05-02", MANIFEST_KEY],
    ["a public key, under the public-keys release by file name", publicKeyArtifactKey(KID), "audit-anchor-public-keys", `${KID}.pub`],
    ["a rotation statement, under the key-rotation release", rotation, "audit-anchor-key-rotation", rotation],
    ["a chain-restart statement, under the key-rotation release", restart, "audit-anchor-key-rotation", restart],
  ])("places %s, and maps the asset back to the key", (_label, key, tag, assetName) => {
    expect(githubLocationForKey(key)).toEqual({ tag, assetName });
    expect(keyForGithubAsset(tag, assetName)).toBe(key);
  });

  it("refuses a key of no known shape", () => {
    expect(() => githubLocationForKey("no-dot")).toThrow(InvalidArtifactKeyError);
    expect(() => githubLocationForKey("2026-05-02.kid-x.jws")).toThrow(InvalidArtifactKeyError);
  });

  it("maps no key for a release that is not an anchor one", () => {
    expect(keyForGithubAsset("v1.2.3", MANIFEST_KEY)).toBeNull();
  });
});

describe("GitHubReleaseDestination — requests", () => {
  it("creates the release, then uploads the asset to its upload_url", async () => {
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse(RELEASE, 201))
      .mockResolvedValueOnce(makeOkResponse({}, 201));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    expect(await createManifest(dest)).toBe("created");

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Create-release call
    const [createUrl, createOpts] = fetchSpy.mock.calls[0];
    expect(createUrl).toBe("https://api.github.com/repos/owner/repo/releases");
    const createInit = createOpts as RequestInit;
    expect(createInit.method).toBe("POST");
    const createBody = JSON.parse(createInit.body as string);
    expect(createBody.tag_name).toBe("audit-anchor-2026-05-02");
    expect(createBody.name).toBe("2026-05-02");
    expect(createBody.draft).toBe(false);

    // Upload-asset call
    const [uploadUrl, uploadOpts] = fetchSpy.mock.calls[1];
    expect(uploadUrl).toBe(
      `https://uploads.github.com/repos/owner/repo/releases/123/assets?name=${MANIFEST_KEY}`,
    );
    const uploadInit = uploadOpts as RequestInit;
    expect(uploadInit.method).toBe("POST");
    const headers = uploadInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("token ghp_xxx");
    expect(headers["Content-Type"]).toBe(ANCHOR_ARTIFACT_CONTENT_TYPE.JWS);
    expect(Buffer.from(uploadInit.body as Uint8Array)).toEqual(Buffer.from("jws-payload"));
  });

  it("passes the caller's signal to every request", async () => {
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse(RELEASE, 201))
      .mockResolvedValueOnce(makeOkResponse({}, 201))
      .mockResolvedValueOnce(makeOkResponse([]))
      .mockResolvedValueOnce(makeErrorResponse(404));
    const { signal } = new AbortController();

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    await createManifest(dest, signal);
    await dest.list(signal);
    await dest.read(MANIFEST_KEY, signal);

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchSpy.mock.calls) {
      expect((init as RequestInit).signal).toBe(signal);
    }
  });

  it("sends requests to the configured API base", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse([]));

    const dest = new GitHubReleaseDestination({
      repo: "owner/repo",
      token: "ghp_xxx",
      apiBaseUrl: "http://127.0.0.1:1",
    });
    await dest.list();

    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:1/repos/owner/repo/releases?per_page=100&page=1");
  });

  it("lists an uploaded asset only under the release its key is stored in", async () => {
    const asset = (name: string) => ({ id: 1, name, state: "uploaded", size: 3, created_at: "2026-05-02T00:05:01Z" });
    const rotation = statementArtifactKey(new Date("2026-05-02T12:00:00.000Z"), STATEMENT_OP.ROTATION, KID);
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse([
        { ...RELEASE, assets: [asset(MANIFEST_KEY)] },
        { ...RELEASE, tag_name: "audit-anchor-2026-05-03", assets: [asset(MANIFEST_KEY)] },
        { ...RELEASE, tag_name: "audit-anchor-key-rotation", assets: [asset(MANIFEST_KEY), asset(rotation), asset("notes.txt")] },
        { ...RELEASE, tag_name: "audit-anchor-public-keys", assets: [asset(`${KID}.pub`), asset(MANIFEST_KEY)] },
      ]),
    );

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });

    expect((await dest.list()).sort()).toEqual([MANIFEST_KEY, rotation, publicKeyArtifactKey(KID)].sort());
  });

  it("downloads an uploaded asset by id as an octet stream", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        makeOkResponse({
          ...RELEASE,
          assets: [{ id: 77, name: MANIFEST_KEY, state: "uploaded", size: 3, created_at: "2026-05-02T00:05:01Z" }],
        }),
      )
      .mockResolvedValueOnce(new Response(Buffer.from("jws"), { status: 200 }));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    expect(await dest.read(MANIFEST_KEY)).toEqual(Buffer.from("jws"));

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/owner/repo/releases/tags/audit-anchor-2026-05-02",
    );
    const [downloadUrl, downloadOpts] = fetchSpy.mock.calls[1];
    expect(downloadUrl).toBe("https://api.github.com/repos/owner/repo/releases/assets/77");
    expect((downloadOpts as RequestInit).headers).toMatchObject({
      Authorization: "token ghp_xxx",
      Accept: "application/octet-stream",
    });
  });
});

describe("GitHubReleaseDestination — failure paths", () => {
  async function failure(run: Promise<unknown>): Promise<unknown> {
    return run.then(
      () => null,
      (err: unknown) => err,
    );
  }

  it("throws when the existing release cannot be fetched after a 422", async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(422))
      .mockResolvedValueOnce(makeErrorResponse(404));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    const error = await failure(createManifest(dest));

    expect(error).toBeInstanceOf(GitHubRequestError);
    expect((error as GitHubRequestError).message).toMatch(/fetch existing release.*HTTP 404/);
  });

  it.each([403, 500])("throws a status token when create-release returns %d", async (status) => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(status));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    const error = await failure(createManifest(dest));

    expect(error).toBeInstanceOf(GitHubRequestError);
    expect((error as GitHubRequestError).code).toBe(`HTTP_${status}`);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws when the asset upload returns a non-2xx other than 422, looking nothing up", async () => {
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse(RELEASE, 201))
      .mockResolvedValueOnce(makeErrorResponse(401));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    const error = await failure(createManifest(dest));

    expect(error).toBeInstanceOf(GitHubRequestError);
    expect((error as GitHubRequestError).code).toBe("HTTP_401");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws when the asset download fails", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        makeOkResponse({
          ...RELEASE,
          assets: [{ id: 77, name: MANIFEST_KEY, state: "uploaded", size: 3, created_at: "2026-05-02T00:05:01Z" }],
        }),
      )
      .mockResolvedValueOnce(makeErrorResponse(503));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    const error = await failure(dest.read(MANIFEST_KEY));

    expect((error as GitHubRequestError).code).toBe("HTTP_503");
  });

  it("propagates fetch network errors", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    await expect(createManifest(dest)).rejects.toThrow("ECONNREFUSED");
  });

  it("refuses a key of no known shape without a request", async () => {
    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });

    await expect(
      dest.create({ artifactBytes: Buffer.from("x"), artifactKey: "no-dot", contentType: ANCHOR_ARTIFACT_CONTENT_TYPE.JWS }),
    ).rejects.toBeInstanceOf(InvalidArtifactKeyError);
    await expect(dest.read("no-dot")).rejects.toBeInstanceOf(InvalidArtifactKeyError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
