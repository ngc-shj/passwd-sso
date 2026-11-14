/**
 * The AnchorDestination contract, as one suite every implementation runs:
 * S3 (MinIO), the filesystem, GitHub Releases (a fake server) and the
 * in-memory destination the unit tests build on.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";
import { ArtifactTooLargeError } from "@/lib/audit/anchor-destinations/destination";
import {
  ANCHOR_ARTIFACT_CONTENT_TYPE,
  InvalidArtifactKeyError,
  STATEMENT_OP,
  buildManifestArtifactKey,
  publicKeyArtifactKey,
  statementArtifactKey,
} from "@/lib/audit/anchor-artifact-keys";
import { kidForPublicKey } from "@/lib/audit/anchor-manifest";
import { AUDIT_ANCHOR_ARTIFACT_MAX_BYTES } from "@/lib/constants/audit/audit";

export const ANCHOR_CONTENT_TYPE = ANCHOR_ARTIFACT_CONTENT_TYPE.JWS;

/** A kid of the derivable shape, unique per call. */
export function randomKid(): string {
  return kidForPublicKey(randomBytes(32));
}

export function manifestKeyFor(date: string, kid = randomKid()): string {
  return buildManifestArtifactKey(new Date(`${date}T00:05:00.000Z`), kid);
}

export async function createArtifact(
  dest: AnchorDestination,
  artifactKey: string,
  artifactBytes: Buffer,
): Promise<"created" | "exists"> {
  return dest.create({ artifactBytes, artifactKey, contentType: ANCHOR_CONTENT_TYPE });
}

/**
 * @param makeEmpty a destination nothing was created in: a fresh S3 prefix,
 *   temp dir, fake server or instance. Its teardown is the caller's.
 */
export function describeAnchorDestinationContract(
  label: string,
  makeEmpty: () => Promise<AnchorDestination> | AnchorDestination,
): void {
  describe(`AnchorDestination contract — ${label}`, () => {
    it("a second create of a key answers exists and leaves the first writer's bytes", async () => {
      const dest = await makeEmpty();
      const key = manifestKeyFor("2026-05-02");
      const first = Buffer.from(`first-${randomBytes(8).toString("hex")}`);

      expect(await createArtifact(dest, key, first)).toBe("created");
      expect(await createArtifact(dest, key, Buffer.from("second-writer"))).toBe("exists");

      expect(await dest.read(key)).toEqual(first);
      expect(await dest.list()).toEqual([key]);
    });

    it("reads null for a key nothing was created at, beside one that was", async () => {
      const dest = await makeEmpty();
      const kid = randomKid();
      const stored = manifestKeyFor("2026-05-02", kid);
      await createArtifact(dest, stored, Buffer.from("stored"));

      expect(await dest.read(manifestKeyFor("2026-05-03", kid))).toBeNull();
      expect(await dest.read(publicKeyArtifactKey(kid))).toBeNull();
      expect(await dest.read(stored)).toEqual(Buffer.from("stored"));
    });

    it("lists nothing when nothing was created", async () => {
      const dest = await makeEmpty();
      expect(await dest.list()).toEqual([]);
    });

    it("lists exactly the created keys, manifest and non-manifest, and reads each back", async () => {
      const dest = await makeEmpty();
      const kid = randomKid();
      const day = new Date("2026-05-03T00:00:00.000Z");
      const artifacts = new Map<string, Buffer>([
        [manifestKeyFor("2026-05-02", kid), Buffer.from("manifest-1")],
        [manifestKeyFor("2026-05-03", kid), Buffer.from("manifest-2")],
        [publicKeyArtifactKey(kid), Buffer.from("public-key")],
        [statementArtifactKey(day, STATEMENT_OP.ROTATION, kid), Buffer.from("rotation")],
        [statementArtifactKey(day, STATEMENT_OP.CHAIN_RESTART, kid), Buffer.from("chain-restart")],
      ]);

      for (const [key, bytes] of artifacts) {
        expect(await createArtifact(dest, key, bytes)).toBe("created");
      }

      expect([...(await dest.list())].sort()).toEqual([...artifacts.keys()].sort());
      for (const [key, bytes] of artifacts) {
        expect(await dest.read(key)).toEqual(bytes);
      }
    });

    it.each([
      ["a bare name", "notes.txt"],
      ["a manifest name under a directory", `sub/${manifestKeyFor("2026-05-02")}`],
      ["a manifest name with a kid of another shape", "2026-05-02.kid-audit-anchor-abc.jws"],
      ["a path that climbs out", "../2026-05-02.kid-audit-anchor-0123456789abcdef.jws"],
      ["a public key with another extension", `public-keys/${randomKid()}.pem`],
    ])("refuses %s on create and on read, storing nothing", async (_label, key) => {
      const dest = await makeEmpty();

      await expect(createArtifact(dest, key, Buffer.from("x"))).rejects.toBeInstanceOf(InvalidArtifactKeyError);
      await expect(dest.read(key)).rejects.toBeInstanceOf(InvalidArtifactKeyError);
      expect(await dest.list()).toEqual([]);
    });

    it("refuses an artifact past the size bound, and accepts one at it", async () => {
      const dest = await makeEmpty();
      const kid = randomKid();
      const atBound = Buffer.alloc(AUDIT_ANCHOR_ARTIFACT_MAX_BYTES, 0x61);
      const pastBound = Buffer.alloc(AUDIT_ANCHOR_ARTIFACT_MAX_BYTES + 1, 0x61);

      await expect(createArtifact(dest, manifestKeyFor("2026-05-02", kid), pastBound)).rejects.toBeInstanceOf(
        ArtifactTooLargeError,
      );
      expect(await dest.list()).toEqual([]);

      const key = manifestKeyFor("2026-05-03", kid);
      expect(await createArtifact(dest, key, atBound)).toBe("created");
      expect((await dest.read(key))?.length).toBe(AUDIT_ANCHOR_ARTIFACT_MAX_BYTES);
    });
  });
}

/** Eight concurrent creates of one key: one writer wins, and its bytes are what is stored. */
export async function expectOneConcurrentCreateWins(dest: AnchorDestination, key: string): Promise<void> {
  const bodies = Array.from({ length: 8 }, (_, i) => Buffer.from(`writer-${i}`));
  const results = await Promise.all(bodies.map((body) => createArtifact(dest, key, body)));

  expect([...results].sort()).toEqual(["created", ...Array<string>(7).fill("exists")]);
  expect(await dest.read(key)).toEqual(bodies[results.indexOf("created")]);
}
