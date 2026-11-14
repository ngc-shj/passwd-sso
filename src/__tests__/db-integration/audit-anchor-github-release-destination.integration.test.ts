/**
 * GitHubReleaseDestination against a node:http fake of the Releases API
 * (src/__tests__/helpers/fake-github-release-server.ts). The real API is not
 * reachable here: the fake is shaped from its documented behaviour, and what
 * the tests pin is the destination's handling of each answer — the destination
 * contract, the mapping of a taken asset name, and the paginated listing.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  GITHUB_ASSET_RESERVATION_STALE_MS,
  GitHubAssetReservedError,
  GitHubReleaseDestination,
  GitHubRequestError,
} from "@/lib/audit/anchor-destinations/github-release-destination";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import {
  ANCHOR_CONTENT_TYPE,
  createArtifact,
  describeAnchorDestinationContract,
  manifestKeyFor,
  randomKid,
} from "../helpers/anchor-destination-contract";
import { FAKE_GITHUB_REPO, startFakeGitHub, type FakeGitHub } from "../helpers/fake-github-release-server";
import { publicKeyArtifactKey } from "@/lib/audit/anchor-artifact-keys";

const fakes: FakeGitHub[] = [];

async function freshFake(): Promise<FakeGitHub> {
  const fake = await startFakeGitHub();
  fakes.push(fake);
  return fake;
}

function destinationFor(fake: FakeGitHub, listPageSize?: number): GitHubReleaseDestination {
  return new GitHubReleaseDestination({
    repo: FAKE_GITHUB_REPO,
    token: "fake-token",
    apiBaseUrl: fake.baseUrl,
    listPageSize,
  });
}

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

describeAnchorDestinationContract("GitHub Releases (fake server)", async () => destinationFor(await freshFake()));

const UPLOAD = /^POST \/upload\/\d+\/assets$/;
const DELETE = /^DELETE /;
const DATE = "2026-05-02";
const TAG = `audit-anchor-${DATE}`;

function agedIso(ageMs: number): string {
  return new Date(Date.now() - ageMs).toISOString();
}

describe("GitHubReleaseDestination — release and asset placement", () => {
  it("creates the dated release, uploads the manifest as its asset, and reuses the release for a second kid", async () => {
    const fake = await freshFake();
    const dest = destinationFor(fake);
    const first = manifestKeyFor(DATE);
    const second = manifestKeyFor(DATE);

    expect(await createArtifact(dest, first, Buffer.from("one"))).toBe("created");
    expect(await createArtifact(dest, second, Buffer.from("two"))).toBe("created");

    expect(fake.releases.map((r) => r.tag_name)).toEqual([TAG]);
    expect(fake.releases[0]?.assets.map((a) => a.name).sort()).toEqual([first, second].sort());
    // The second create found the tag taken and fetched the release.
    expect(fake.count("POST /repos/test-org/test-repo/releases")).toBe(2);
    expect(fake.count(`GET /repos/test-org/test-repo/releases/tags/${TAG}`)).toBe(1);
  });

  it("stores binary bytes unchanged", async () => {
    const fake = await freshFake();
    const dest = destinationFor(fake);
    const key = manifestKeyFor(DATE);
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x0a, 0xc3, 0x28]);

    await createArtifact(dest, key, bytes);

    expect(fake.releases[0]?.assets[0]?.content).toEqual(bytes);
    expect(await dest.read(key)).toEqual(bytes);
  });

  it("stores a public key under the public-keys release, by its file name", async () => {
    const fake = await freshFake();
    const dest = destinationFor(fake);
    const kid = randomKid();

    await createArtifact(dest, publicKeyArtifactKey(kid), Buffer.from("ab".repeat(32)));

    expect(fake.releases.map((r) => r.tag_name)).toEqual(["audit-anchor-public-keys"]);
    expect(fake.releases[0]?.assets.map((a) => a.name)).toEqual([`${kid}.pub`]);
  });
});

describe("GitHubReleaseDestination — a taken asset name", () => {
  it("answers exists for an uploaded holder, deleting nothing and leaving its bytes", async () => {
    const fake = await freshFake();
    const key = manifestKeyFor(DATE);
    const holder = fake.addAsset(TAG, { name: key, state: "uploaded", content: Buffer.from("first-writer") });

    expect(await createArtifact(destinationFor(fake), key, Buffer.from("second-writer"))).toBe("exists");

    expect(fake.count(DELETE)).toBe(0);
    expect(fake.count(UPLOAD)).toBe(1);
    expect(fake.releases[0]?.assets).toEqual([holder]);
    expect(holder.content).toEqual(Buffer.from("first-writer"));
  });

  it("removes a stale reservation, exactly that asset id, then uploads once more", async () => {
    const fake = await freshFake();
    const key = manifestKeyFor(DATE);
    const stale = fake.addAsset(TAG, {
      name: key,
      state: "open",
      created_at: agedIso(GITHUB_ASSET_RESERVATION_STALE_MS + MS_PER_MINUTE),
    });
    const dest = destinationFor(fake);

    expect(await createArtifact(dest, key, Buffer.from("content"))).toBe("created");

    expect(fake.deletedAssetIds).toEqual([stale.id]);
    expect(fake.count(DELETE)).toBe(1);
    expect(fake.count(UPLOAD)).toBe(2);
    expect(await dest.read(key)).toEqual(Buffer.from("content"));
  });

  it("answers exists, deleting nothing, when a stale reservation is uploaded by the time it is read again", async () => {
    const fake = await freshFake();
    const key = manifestKeyFor(DATE);
    const holder = fake.addAsset(TAG, {
      name: key,
      state: "open",
      created_at: agedIso(GITHUB_ASSET_RESERVATION_STALE_MS + MS_PER_MINUTE),
      content: Buffer.from("other-writer"),
    });
    // The other writer's upload finishes between the first look and the re-read.
    fake.beforeRequest = (method, path) => {
      if (method === "GET" && path.endsWith(`/releases/assets/${holder.id}`)) holder.state = "uploaded";
    };
    const dest = destinationFor(fake);

    expect(await createArtifact(dest, key, Buffer.from("mine"))).toBe("exists");

    expect(fake.count(DELETE)).toBe(0);
    expect(fake.count(UPLOAD)).toBe(1);
    expect(await dest.read(key)).toEqual(Buffer.from("other-writer"));
  });

  it("throws for a reservation younger than the stale bound, deleting nothing", async () => {
    const fake = await freshFake();
    const key = manifestKeyFor(DATE);
    fake.addAsset(TAG, {
      name: key,
      state: "open",
      created_at: agedIso(GITHUB_ASSET_RESERVATION_STALE_MS - MS_PER_MINUTE),
    });

    await expect(createArtifact(destinationFor(fake), key, Buffer.from("content"))).rejects.toBeInstanceOf(
      GitHubAssetReservedError,
    );

    expect(fake.count(DELETE)).toBe(0);
    expect(fake.count(UPLOAD)).toBe(1);
  });

  it("throws on a second 422 after the re-upload, without a second delete", async () => {
    const fake = await freshFake();
    const key = manifestKeyFor(DATE);
    const stale = fake.addAsset(TAG, {
      name: key,
      state: "open",
      created_at: agedIso(GITHUB_ASSET_RESERVATION_STALE_MS + MS_PER_MINUTE),
    });
    // Another writer reserves the name again right after the delete.
    fake.beforeRequest = (method) => {
      if (method === "POST" && fake.deletedAssetIds.length === 1 && fake.releases[0]?.assets.length === 0) {
        fake.addAsset(TAG, { name: key, state: "open" });
      }
    };

    const error = await createArtifact(destinationFor(fake), key, Buffer.from("content")).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(GitHubRequestError);
    expect((error as GitHubRequestError).code).toBe("HTTP_422");
    expect(fake.deletedAssetIds).toEqual([stale.id]);
    expect(fake.count(UPLOAD)).toBe(2);
  });

  it("throws when the reservation's delete fails, and does not upload again", async () => {
    const fake = await freshFake();
    const key = manifestKeyFor(DATE);
    fake.addAsset(TAG, {
      name: key,
      state: "open",
      created_at: agedIso(GITHUB_ASSET_RESERVATION_STALE_MS + MS_PER_MINUTE),
    });
    fake.deleteStatus = 403;

    const error = await createArtifact(destinationFor(fake), key, Buffer.from("content")).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(GitHubRequestError);
    expect((error as GitHubRequestError).code).toBe("HTTP_403");
    expect(fake.count(DELETE)).toBe(1);
    expect(fake.count(UPLOAD)).toBe(1);
    expect(fake.releases[0]?.assets).toHaveLength(1);
  });

  it("throws on a 422 that no asset of that name explains", async () => {
    const fake = await freshFake();
    const key = manifestKeyFor(DATE);
    fake.rejectNextUpload = true;
    const dest = destinationFor(fake);

    const error = await createArtifact(dest, key, Buffer.from("content")).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(GitHubRequestError);
    expect((error as GitHubRequestError).code).toBe("HTTP_422");
    expect(fake.count(DELETE)).toBe(0);
    expect(fake.count(UPLOAD)).toBe(1);
    // The same create, not refused, stores the artifact.
    expect(await createArtifact(dest, key, Buffer.from("content"))).toBe("created");
  });
});

describe("GitHubReleaseDestination — read and list", () => {
  it("does not read or list an asset that is not uploaded", async () => {
    const fake = await freshFake();
    const reserved = manifestKeyFor(DATE);
    const stored = manifestKeyFor(DATE);
    fake.addAsset(TAG, { name: reserved, state: "open", content: Buffer.from("partial") });
    fake.addAsset(TAG, { name: stored, state: "uploaded", content: Buffer.from("whole") });
    const dest = destinationFor(fake);

    expect(await dest.read(reserved)).toBeNull();
    expect(await dest.read(stored)).toEqual(Buffer.from("whole"));
    expect(await dest.list()).toEqual([stored]);
  });

  it("lists every page: 5 dated releases at page size 2 give the exact set in 3 requests", async () => {
    const fake = await freshFake();
    const dest = destinationFor(fake, 2);
    const keys = ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05"].map((d) => manifestKeyFor(d));
    for (const key of keys) {
      await dest.create({ artifactBytes: Buffer.from(key), artifactKey: key, contentType: ANCHOR_CONTENT_TYPE });
    }
    fake.requests.length = 0;

    expect([...(await dest.list())].sort()).toEqual([...keys].sort());
    expect(fake.count("GET /repos/test-org/test-repo/releases")).toBe(3);
  });

  it("lists a full last page and then an empty one", async () => {
    const fake = await freshFake();
    const dest = destinationFor(fake, 2);
    const keys = ["2026-05-01", "2026-05-02"].map((d) => manifestKeyFor(d));
    for (const key of keys) await createArtifact(dest, key, Buffer.from(key));
    fake.requests.length = 0;

    expect([...(await dest.list())].sort()).toEqual([...keys].sort());
    expect(fake.count("GET /repos/test-org/test-repo/releases")).toBe(2);
  });

  it("leaves out releases that are not anchor ones", async () => {
    const fake = await freshFake();
    const dest = destinationFor(fake);
    const key = manifestKeyFor(DATE);
    await createArtifact(dest, key, Buffer.from("manifest"));
    fake.addAsset("v1.2.3", { name: "app.tar.gz", state: "uploaded" });

    expect(await dest.list()).toEqual([key]);
  });

  it("throws on a listing the API refuses", async () => {
    const fake = await freshFake();
    const dest = new GitHubReleaseDestination({ repo: "other/repo", token: "fake-token", apiBaseUrl: fake.baseUrl });

    const error = await dest.list().then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(GitHubRequestError);
    expect((error as GitHubRequestError).code).toBe("HTTP_404");
  });
});
