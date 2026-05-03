import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitHubReleaseDestination } from "./github-release-destination";

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
});

describe("GitHubReleaseDestination — upload happy path", () => {
  it("creates a release then uploads the asset", async () => {
    fetchSpy
      // First: POST /releases → create release
      .mockResolvedValueOnce(
        makeOkResponse(
          {
            id: 123,
            upload_url: "https://uploads.github.com/repos/owner/repo/releases/123/assets{?name,label}",
          },
          201,
        ),
      )
      // Second: POST upload URL → upload asset
      .mockResolvedValueOnce(makeOkResponse({}, 201));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    await dest.upload({
      artifactBytes: Buffer.from("jws-payload"),
      artifactKey: "2026-05-02.kid-audit-anchor-abc.jws",
      contentType: "application/jose",
    });

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
      "https://uploads.github.com/repos/owner/repo/releases/123/assets?name=2026-05-02.kid-audit-anchor-abc.jws",
    );
    const uploadInit = uploadOpts as RequestInit;
    expect(uploadInit.method).toBe("POST");
    const headers = uploadInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("token ghp_xxx");
    expect(headers["Content-Type"]).toBe("application/jose");
  });

  it("encodes special characters in artifactKey for the upload URL ?name=", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        makeOkResponse(
          { id: 1, upload_url: "https://uploads.github.com/x{?name,label}" },
          201,
        ),
      )
      .mockResolvedValueOnce(makeOkResponse({}, 201));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    await dest.upload({
      artifactBytes: Buffer.from("x"),
      artifactKey: "weird key with space.jws",
      contentType: "application/jose",
    });

    const uploadUrl = fetchSpy.mock.calls[1][0] as string;
    expect(uploadUrl).toContain("name=weird%20key%20with%20space.jws");
  });
});

describe("GitHubReleaseDestination — release already exists (422 fallback)", () => {
  it("fetches existing release on 422 then uploads", async () => {
    fetchSpy
      // create returns 422 (release with tag exists)
      .mockResolvedValueOnce(makeErrorResponse(422))
      // get-by-tag returns existing release
      .mockResolvedValueOnce(
        makeOkResponse({
          id: 999,
          upload_url: "https://uploads.github.com/repos/o/r/releases/999/assets{?name,label}",
        }),
      )
      // upload succeeds
      .mockResolvedValueOnce(makeOkResponse({}, 201));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    await dest.upload({
      artifactBytes: Buffer.from("x"),
      artifactKey: "2026-05-02.kid-x.jws",
      contentType: "application/jose",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const [getByTagUrl] = fetchSpy.mock.calls[1];
    expect(getByTagUrl).toBe(
      "https://api.github.com/repos/owner/repo/releases/tags/audit-anchor-2026-05-02",
    );
  });

  it("throws when get-by-tag also fails after 422", async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(422))
      .mockResolvedValueOnce(makeErrorResponse(404));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    await expect(
      dest.upload({
        artifactBytes: Buffer.from("x"),
        artifactKey: "k.jws",
        contentType: "application/jose",
      }),
    ).rejects.toThrow(/failed to fetch existing release.*HTTP 404/);
  });
});

describe("GitHubReleaseDestination — failure paths", () => {
  it("throws when create-release returns non-422 error (e.g., 403)", async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(403));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    await expect(
      dest.upload({
        artifactBytes: Buffer.from("x"),
        artifactKey: "k.jws",
        contentType: "application/jose",
      }),
    ).rejects.toThrow(/failed to create release.*HTTP 403/);
  });

  it("throws when create-release returns 500", async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(500));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    await expect(
      dest.upload({
        artifactBytes: Buffer.from("x"),
        artifactKey: "k.jws",
        contentType: "application/jose",
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("throws when asset upload returns non-2xx", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        makeOkResponse(
          { id: 1, upload_url: "https://uploads.github.com/x{?name,label}" },
          201,
        ),
      )
      .mockResolvedValueOnce(makeErrorResponse(401));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    await expect(
      dest.upload({
        artifactBytes: Buffer.from("x"),
        artifactKey: "k.jws",
        contentType: "application/jose",
      }),
    ).rejects.toThrow(/failed to upload asset.*HTTP 401/);
  });

  it("propagates fetch network errors", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    await expect(
      dest.upload({
        artifactBytes: Buffer.from("x"),
        artifactKey: "k.jws",
        contentType: "application/jose",
      }),
    ).rejects.toThrow("ECONNREFUSED");
  });
});

describe("GitHubReleaseDestination — tag derivation", () => {
  it("derives tag from artifactKey date prefix", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        makeOkResponse(
          { id: 1, upload_url: "https://uploads.github.com/x{?name,label}" },
          201,
        ),
      )
      .mockResolvedValueOnce(makeOkResponse({}, 201));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    await dest.upload({
      artifactBytes: Buffer.from("x"),
      artifactKey: "2030-12-31.kid-foo.jws",
      contentType: "application/jose",
    });

    const createBody = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(createBody.tag_name).toBe("audit-anchor-2030-12-31");
    expect(createBody.name).toBe("2030-12-31");
  });

  it("falls back to full artifactKey when no '.' separator present", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        makeOkResponse(
          { id: 1, upload_url: "https://uploads.github.com/x{?name,label}" },
          201,
        ),
      )
      .mockResolvedValueOnce(makeOkResponse({}, 201));

    const dest = new GitHubReleaseDestination({ repo: "owner/repo", token: "ghp_xxx" });
    await dest.upload({
      artifactBytes: Buffer.from("x"),
      artifactKey: "no-dot",
      contentType: "application/jose",
    });

    const createBody = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(createBody.tag_name).toBe("audit-anchor-no-dot");
  });
});
