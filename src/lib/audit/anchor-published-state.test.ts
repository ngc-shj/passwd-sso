/**
 * The published state, read from an in-memory destination holding real signed
 * objects. Each clause of "verified" has the case that fails it and the
 * all-pass twin; the caches are exercised through the reads they save.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  PublishedObjectUnverifiableError,
  UNRECOGNISED_KEYS_LOGGED_MAX,
  UNVERIFIABLE_DETAIL,
  createAnchorKeyCache,
  publishedStateFromListing,
  readPublishedState,
  readVerifiedManifest,
  type OwnKey,
} from "./anchor-published-state";
import { InMemoryDestination } from "@/lib/audit/anchor-destinations/in-memory-destination";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";
import { buildManifestArtifactKey, publicKeyArtifactKey } from "@/lib/audit/anchor-artifact-keys";
import { publicKeyForSigningKey } from "@/lib/audit/anchor-manifest";
import { MS_PER_DAY } from "@/lib/constants/time";
import {
  archivePublicKey,
  kidOf,
  signedManifest,
  storeArtifact,
  storeManifest,
} from "@/__tests__/helpers/anchor-manifest-fixtures";

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn() }),
}));

const D1 = new Date("2026-01-14T00:05:00.000Z");
const D2 = new Date(D1.getTime() + MS_PER_DAY);

const OWN_SEED = randomBytes(32);
const OWN_PUBLIC = publicKeyForSigningKey(OWN_SEED);
const OWN_KID = kidOf(OWN_SEED);

/** A seed whose kid sorts after the own kid, so "the greatest key" is the foreign one. */
function foreignSeedSortingAfterOwn(): Buffer {
  for (;;) {
    const seed = randomBytes(32);
    if (kidOf(seed) > OWN_KID) return seed;
  }
}
const FOREIGN_SEED = foreignSeedSortingAfterOwn();
const FOREIGN_PUBLIC = publicKeyForSigningKey(FOREIGN_SEED);
const FOREIGN_KID = kidOf(FOREIGN_SEED);

function own(): OwnKey {
  return { publicKey: OWN_PUBLIC, keyCache: createAnchorKeyCache() };
}

/** The destination, recording every key read. */
function recording(dest: InMemoryDestination): { dest: AnchorDestination; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    dest: {
      name: dest.name,
      create: (args) => dest.create(args),
      read: (key, signal) => {
        reads.push(key);
        return dest.read(key, signal);
      },
      list: (signal) => dest.list(signal),
    },
  };
}

async function expectUnverifiable(work: Promise<unknown>, detail: string, artifactKey: string): Promise<void> {
  const err = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PublishedObjectUnverifiableError);
  expect(err).toMatchObject({ code: "PUBLISHED_OBJECT_UNVERIFIABLE", detail, artifactKey });
}

beforeEach(() => {
  mockWarn.mockClear();
});

describe("readVerifiedManifest", () => {
  it("returns an own-kid manifest with its bytes, date, kid and payload digest", async () => {
    const dest = new InMemoryDestination();
    const planted = signedManifest({ signingKey: OWN_SEED, boundary: D1 });
    await storeManifest(dest, planted);

    const verified = await readVerifiedManifest(dest, planted.artifactKey, own(), await dest.list());

    expect(verified).toEqual({
      artifactKey: planted.artifactKey,
      date: "2026-01-14",
      kid: OWN_KID,
      bytes: planted.bytes,
      manifest: planted.manifest,
      sha256: planted.sha256,
    });
  });

  it("never looks the own kid up in the archive, whatever the archive holds for it", async () => {
    const mem = new InMemoryDestination();
    const planted = signedManifest({ signingKey: OWN_SEED, boundary: D1 });
    await storeManifest(mem, planted);
    await storeArtifact(mem, publicKeyArtifactKey(OWN_KID), Buffer.from("not a key"));
    const { dest, reads } = recording(mem);

    const verified = await readVerifiedManifest(dest, planted.artifactKey, own(), await dest.list());

    expect(verified.kid).toBe(OWN_KID);
    expect(reads).toEqual([planted.artifactKey]);
  });

  it("resolves a foreign kid from the archive when its key is listed and derives that kid", async () => {
    const dest = new InMemoryDestination();
    const planted = signedManifest({ signingKey: FOREIGN_SEED, boundary: D1 });
    await storeManifest(dest, planted);
    await archivePublicKey(dest, FOREIGN_PUBLIC);

    const verified = await readVerifiedManifest(dest, planted.artifactKey, own(), await dest.list());

    expect(verified).toMatchObject({ kid: FOREIGN_KID, sha256: planted.sha256 });
  });

  it("refuses a foreign kid whose public key is not archived", async () => {
    const dest = new InMemoryDestination();
    const planted = signedManifest({ signingKey: FOREIGN_SEED, boundary: D1 });
    await storeManifest(dest, planted);

    await expectUnverifiable(
      readVerifiedManifest(dest, planted.artifactKey, own(), await dest.list()),
      UNVERIFIABLE_DETAIL.PUBLIC_KEY_NOT_ARCHIVED,
      planted.artifactKey,
    );
  });

  it.each([
    ["is not a public key", Buffer.from("not a key\n")],
    ["is another key's, which does not derive the kid", Buffer.from(`${OWN_PUBLIC.toString("hex")}\n`)],
  ])("refuses a foreign kid whose archived file %s", async (_label, archived) => {
    const dest = new InMemoryDestination();
    const planted = signedManifest({ signingKey: FOREIGN_SEED, boundary: D1 });
    await storeManifest(dest, planted);
    await storeArtifact(dest, publicKeyArtifactKey(FOREIGN_KID), archived);

    await expectUnverifiable(
      readVerifiedManifest(dest, planted.artifactKey, own(), await dest.list()),
      UNVERIFIABLE_DETAIL.PUBLIC_KEY_INVALID,
      planted.artifactKey,
    );
  });

  it("refuses an object that is not a signed manifest", async () => {
    const dest = new InMemoryDestination();
    const artifactKey = buildManifestArtifactKey(D1, OWN_KID);
    await storeArtifact(dest, artifactKey, Buffer.from("garbage"));

    await expectUnverifiable(
      readVerifiedManifest(dest, artifactKey, own(), await dest.list()),
      UNVERIFIABLE_DETAIL.SIGNATURE_INVALID,
      artifactKey,
    );
  });

  it("refuses a manifest stored under a key naming a kid its header does not", async () => {
    // Signed by the foreign key, stored under the own kid's name: the header's
    // kid is not the key the name resolves to.
    const dest = new InMemoryDestination();
    const artifactKey = buildManifestArtifactKey(D1, OWN_KID);
    await storeManifest(dest, signedManifest({ signingKey: FOREIGN_SEED, boundary: D1, artifactKey }));
    await archivePublicKey(dest, FOREIGN_PUBLIC);

    await expectUnverifiable(
      readVerifiedManifest(dest, artifactKey, own(), await dest.list()),
      UNVERIFIABLE_DETAIL.SIGNATURE_INVALID,
      artifactKey,
    );
  });

  it("refuses a manifest whose anchoredAt is another day than its key's date", async () => {
    const dest = new InMemoryDestination();
    const artifactKey = buildManifestArtifactKey(D2, OWN_KID);
    await storeManifest(dest, signedManifest({ signingKey: OWN_SEED, boundary: D1, artifactKey }));

    await expectUnverifiable(
      readVerifiedManifest(dest, artifactKey, own(), await dest.list()),
      UNVERIFIABLE_DETAIL.DATE_MISMATCH,
      artifactKey,
    );
  });

  it("refuses a listed key whose object is gone, and a key that is not a manifest's", async () => {
    const dest = new InMemoryDestination();
    const artifactKey = buildManifestArtifactKey(D1, OWN_KID);

    await expectUnverifiable(
      readVerifiedManifest(dest, artifactKey, own(), [artifactKey]),
      UNVERIFIABLE_DETAIL.OBJECT_MISSING,
      artifactKey,
    );
    await expectUnverifiable(
      readVerifiedManifest(dest, publicKeyArtifactKey(OWN_KID), own(), []),
      UNVERIFIABLE_DETAIL.NOT_A_MANIFEST_KEY,
      publicKeyArtifactKey(OWN_KID),
    );
  });

  it("throws a destination error as it is, not as unverifiable", async () => {
    const failing: AnchorDestination = {
      name: "failing",
      create: async () => "created",
      read: async () => {
        throw Object.assign(new Error("denied"), { code: "AccessDenied" });
      },
      list: async () => [],
    };

    await expect(
      readVerifiedManifest(failing, buildManifestArtifactKey(D1, OWN_KID), own(), []),
    ).rejects.toMatchObject({ code: "AccessDenied" });
  });

  it("does not cache a miss: the key archived after it resolves on the same cache, and is then read no more", async () => {
    const mem = new InMemoryDestination();
    const planted = signedManifest({ signingKey: FOREIGN_SEED, boundary: D1 });
    await storeManifest(mem, planted);
    const { dest, reads } = recording(mem);
    const ownKey = own();

    await expect(readVerifiedManifest(dest, planted.artifactKey, ownKey, await dest.list())).rejects.toBeInstanceOf(
      PublishedObjectUnverifiableError,
    );
    await archivePublicKey(mem, FOREIGN_PUBLIC);
    await expect(readVerifiedManifest(dest, planted.artifactKey, ownKey, await dest.list())).resolves.toMatchObject({
      kid: FOREIGN_KID,
    });

    reads.length = 0;
    await readVerifiedManifest(dest, planted.artifactKey, ownKey, await dest.list());
    expect(reads).toEqual([planted.artifactKey]);
  });

  it("keeps resolved keys on the cache it was handed, not across caches", async () => {
    const dest = new InMemoryDestination();
    const planted = signedManifest({ signingKey: FOREIGN_SEED, boundary: D1 });
    await storeManifest(dest, planted);
    await archivePublicKey(dest, FOREIGN_PUBLIC);
    const resolved = own();
    await readVerifiedManifest(dest, planted.artifactKey, resolved, await dest.list());

    // A listing without the archive: only a cache that resolved the key before verifies.
    const withoutArchive = [planted.artifactKey];
    await expect(readVerifiedManifest(dest, planted.artifactKey, resolved, withoutArchive)).resolves.toMatchObject({
      kid: FOREIGN_KID,
    });
    await expectUnverifiable(
      readVerifiedManifest(dest, planted.artifactKey, own(), withoutArchive),
      UNVERIFIABLE_DETAIL.PUBLIC_KEY_NOT_ARCHIVED,
      planted.artifactKey,
    );
    await expectUnverifiable(
      readVerifiedManifest(dest, planted.artifactKey, { publicKey: OWN_PUBLIC }, withoutArchive),
      UNVERIFIABLE_DETAIL.PUBLIC_KEY_NOT_ARCHIVED,
      planted.artifactKey,
    );
  });
});

describe("readPublishedState", () => {
  it("reports an empty destination: no latest, nothing published, nothing archived", async () => {
    expect(await readPublishedState(new InMemoryDestination(), own())).toEqual({
      latest: null,
      latestDateKeyCount: 0,
      ownKidHasPublished: false,
      ownPublicKeyArchived: false,
      manifestKeys: [],
    });
  });

  it("takes the manifest on the greatest date as latest and reads only that one", async () => {
    const mem = new InMemoryDestination();
    const older = buildManifestArtifactKey(D1, OWN_KID);
    await storeArtifact(mem, older, Buffer.from("never read"));
    const newer = signedManifest({ signingKey: OWN_SEED, boundary: D2 });
    await storeManifest(mem, newer);
    const { dest, reads } = recording(mem);

    const state = await readPublishedState(dest, own());

    expect(state.latest).toMatchObject({ artifactKey: newer.artifactKey, sha256: newer.sha256 });
    expect(state.latestDateKeyCount).toBe(1);
    expect([...state.manifestKeys].sort()).toEqual([older, newer.artifactKey].sort());
    expect(reads).toEqual([newer.artifactKey]);
  });

  it("with two keys on the latest date, takes the own-kid one though the other sorts greater, and counts both", async () => {
    const dest = new InMemoryDestination();
    const ours = signedManifest({ signingKey: OWN_SEED, boundary: D2 });
    const theirs = signedManifest({ signingKey: FOREIGN_SEED, boundary: D2 });
    expect(theirs.artifactKey > ours.artifactKey).toBe(true);
    await storeManifest(dest, ours);
    await storeManifest(dest, theirs);

    const state = await readPublishedState(dest, own());

    expect(state.latest?.artifactKey).toBe(ours.artifactKey);
    expect(state.latestDateKeyCount).toBe(2);
  });

  it("with no own-kid key on the latest date, takes the greatest key", async () => {
    const dest = new InMemoryDestination();
    const lowerSeed = (() => {
      for (;;) {
        const seed = randomBytes(32);
        if (kidOf(seed) < FOREIGN_KID) return seed;
      }
    })();
    const lower = signedManifest({ signingKey: lowerSeed, boundary: D2 });
    const greater = signedManifest({ signingKey: FOREIGN_SEED, boundary: D2 });
    await storeManifest(dest, lower);
    await storeManifest(dest, greater);
    await archivePublicKey(dest, FOREIGN_PUBLIC);

    const state = await readPublishedState(dest, own());

    expect(state.latest?.artifactKey).toBe(greater.artifactKey);
    expect(state.latestDateKeyCount).toBe(2);
  });

  it("does not take a non-manifest key that sorts last as latest", async () => {
    const dest = new InMemoryDestination();
    const planted = signedManifest({ signingKey: OWN_SEED, boundary: D1 });
    await storeManifest(dest, planted);
    await archivePublicKey(dest, FOREIGN_PUBLIC);
    const keys = await dest.list();
    expect([...keys].sort().at(-1)).toBe(publicKeyArtifactKey(FOREIGN_KID));

    const state = await readPublishedState(dest, own());

    expect(state.latest?.artifactKey).toBe(planted.artifactKey);
    expect(state.manifestKeys).toEqual([planted.artifactKey]);
  });

  it("reads ownKidHasPublished from key names alone", async () => {
    const dest = new InMemoryDestination();
    await storeArtifact(dest, buildManifestArtifactKey(D1, OWN_KID), Buffer.from("never read"));
    await storeManifest(dest, signedManifest({ signingKey: FOREIGN_SEED, boundary: D2 }));
    await archivePublicKey(dest, FOREIGN_PUBLIC);

    expect((await readPublishedState(dest, own())).ownKidHasPublished).toBe(true);

    const foreignOnly = new InMemoryDestination();
    await storeManifest(foreignOnly, signedManifest({ signingKey: FOREIGN_SEED, boundary: D2 }));
    await archivePublicKey(foreignOnly, FOREIGN_PUBLIC);
    expect((await readPublishedState(foreignOnly, own())).ownKidHasPublished).toBe(false);
  });

  it("reports the own public key archived only when the archived file holds that key", async () => {
    const absent = new InMemoryDestination();
    expect((await readPublishedState(absent, own())).ownPublicKeyArchived).toBe(false);

    const otherContent = new InMemoryDestination();
    await storeArtifact(
      otherContent,
      publicKeyArtifactKey(OWN_KID),
      Buffer.from(`${FOREIGN_PUBLIC.toString("hex")}\n`),
    );
    expect((await readPublishedState(otherContent, own())).ownPublicKeyArchived).toBe(false);

    const archived = new InMemoryDestination();
    await archivePublicKey(archived, OWN_PUBLIC);
    expect((await readPublishedState(archived, own())).ownPublicKeyArchived).toBe(true);
  });

  it("reads the own archived key until it matches once, then no more on that cache", async () => {
    const mem = new InMemoryDestination();
    const { dest, reads } = recording(mem);
    const ownKey = own();

    expect((await readPublishedState(dest, ownKey)).ownPublicKeyArchived).toBe(false);
    await archivePublicKey(mem, OWN_PUBLIC);
    expect((await readPublishedState(dest, ownKey)).ownPublicKeyArchived).toBe(true);
    expect(reads).toEqual([publicKeyArtifactKey(OWN_KID)]);

    expect((await readPublishedState(dest, ownKey)).ownPublicKeyArchived).toBe(true);
    expect(reads).toEqual([publicKeyArtifactKey(OWN_KID)]);
    // Another cache reads it again.
    expect((await readPublishedState(dest, own())).ownPublicKeyArchived).toBe(true);
    expect(reads).toHaveLength(2);
  });

  it("logs and ignores a key that matches the bucket policy's manifest pattern but is not a manifest key", async () => {
    const dest = new InMemoryDestination();
    const planted = signedManifest({ signingKey: OWN_SEED, boundary: D1 });
    await storeManifest(dest, planted);
    // Sorts after every real key of any date the test uses.
    const stray = "9999-99-99.kid-not-a-kid.jws";

    const state = await publishedStateFromListing(dest, own(), [...(await dest.list()), stray, "notes.txt"]);

    expect(state.latest?.artifactKey).toBe(planted.artifactKey);
    expect(state.manifestKeys).toEqual([planted.artifactKey]);
    expect(mockWarn.mock.calls.map(([fields]) => fields)).toEqual([
      { count: 1, artifactKeys: [stray], _logType: "audit-anchor-publisher.unrecognised_manifest_key" },
    ]);
  });

  it("logs one line per listing for any number of unrecognised keys, naming the first few and counting all", async () => {
    const dest = new InMemoryDestination();
    const strays = Array.from({ length: UNRECOGNISED_KEYS_LOGGED_MAX + 3 }, (_, i) => `9999-99-9${i}.kid-not-a-kid.jws`);

    await publishedStateFromListing(dest, own(), strays);

    expect(mockWarn.mock.calls.map(([fields]) => fields)).toEqual([
      {
        count: strays.length,
        artifactKeys: strays.slice(0, UNRECOGNISED_KEYS_LOGGED_MAX),
        _logType: "audit-anchor-publisher.unrecognised_manifest_key",
      },
    ]);
  });

  it("logs nothing about unrecognised keys when every key is recognised or of another shape", async () => {
    const dest = new InMemoryDestination();
    const planted = signedManifest({ signingKey: OWN_SEED, boundary: D1 });
    await storeManifest(dest, planted);

    await publishedStateFromListing(dest, own(), [...(await dest.list()), "notes.txt"]);

    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("fails as unverifiable when the latest object does not verify, though an older one would", async () => {
    const dest = new InMemoryDestination();
    await storeManifest(dest, signedManifest({ signingKey: OWN_SEED, boundary: D1 }));
    const latestKey = buildManifestArtifactKey(D2, OWN_KID);
    await storeArtifact(dest, latestKey, Buffer.from("garbage"));

    await expectUnverifiable(readPublishedState(dest, own()), UNVERIFIABLE_DETAIL.SIGNATURE_INVALID, latestKey);
  });
});
