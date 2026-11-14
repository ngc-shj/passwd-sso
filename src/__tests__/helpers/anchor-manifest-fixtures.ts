/**
 * Signed anchor objects for tests that plant what a destination holds: a
 * manifest another run (or another identity) published, an archived public
 * key. Built with the real signing functions, so a planted object verifies or
 * fails for the reason the test names and no other.
 */
import { createHash, randomBytes } from "node:crypto";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";
import { ANCHOR_ARTIFACT_CONTENT_TYPE, buildManifestArtifactKey, publicKeyArtifactKey } from "@/lib/audit/anchor-artifact-keys";
import { IN_MEMORY_LOCATION } from "@/lib/audit/anchor-destinations/in-memory-destination";
import {
  buildManifest,
  canonicalize,
  kidForPublicKey,
  publicKeyForSigningKey,
  sign,
  type AnchorRow,
  type Manifest,
  type ManifestV1,
  type ManifestV2,
} from "@/lib/audit/anchor-manifest";

export const ANCHOR_CONTENT_TYPE = ANCHOR_ARTIFACT_CONTENT_TYPE.JWS;

export function kidOf(signingKey: Buffer): string {
  return kidForPublicKey(publicKeyForSigningKey(signingKey));
}

export type SignedManifest = {
  artifactKey: string;
  bytes: Buffer;
  manifest: Manifest;
  /** Over the payload bytes — what the next manifest's `previousManifest.sha256` names. */
  sha256: string;
};

/**
 * A manifest for `boundary` signed by `signingKey`, at the key that signer's
 * publisher would store it under. `artifactKey` overrides the key alone, for
 * an object stored under a name its content does not match. `location` is
 * the destination's the manifest is bound to (default: every in-memory
 * destination's). `version: 1` gives the format earlier releases wrote,
 * which names no location.
 */
export function signedManifest(opts: {
  signingKey: Buffer;
  boundary: Date;
  deploymentId?: string;
  tagSecret?: Buffer;
  tenants?: AnchorRow[];
  previousManifest?: { uri: string; sha256: string } | null;
  artifactKey?: string;
  location?: string;
  version?: Manifest["version"];
}): SignedManifest {
  const current = buildManifest({
    tenants: opts.tenants ?? [],
    deploymentId: opts.deploymentId ?? "planted-deployment",
    anchoredAt: opts.boundary,
    previousManifest: opts.previousManifest ?? null,
    tagSecret: opts.tagSecret ?? randomBytes(32),
    location: opts.location ?? IN_MEMORY_LOCATION,
  });
  const manifest = opts.version === 1 ? legacyManifest(current) : current;
  const canonical = canonicalize(manifest);
  return {
    artifactKey: opts.artifactKey ?? buildManifestArtifactKey(opts.boundary, kidOf(opts.signingKey)),
    bytes: Buffer.from(sign(canonical, opts.signingKey), "utf-8"),
    manifest,
    sha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

/** `manifest` as a release before format version 2 wrote it. */
export function legacyManifest(manifest: ManifestV2): ManifestV1 {
  const { chainLocation: _dropped, ...body } = manifest;
  return { ...body, $schema: "https://passwd-sso.example/schemas/audit-anchor-manifest-v1.json", version: 1 };
}

export async function storeArtifact(dest: AnchorDestination, artifactKey: string, artifactBytes: Buffer): Promise<void> {
  const result = await dest.create({ artifactBytes, artifactKey, contentType: ANCHOR_CONTENT_TYPE });
  if (result !== "created") throw new Error(`fixture: ${artifactKey} is already stored`);
}

export async function storeManifest(dest: AnchorDestination, planted: SignedManifest): Promise<void> {
  await storeArtifact(dest, planted.artifactKey, planted.bytes);
}

/** Archive a public key as `public-keys/<kid>.pub`, in the text form the archive holds. */
export async function archivePublicKey(dest: AnchorDestination, publicKey: Buffer): Promise<void> {
  await storeArtifact(
    dest,
    publicKeyArtifactKey(kidForPublicKey(publicKey)),
    Buffer.from(`${publicKey.toString("hex")}\n`, "utf-8"),
  );
}

export type TrackedDestination = {
  dest: AnchorDestination;
  /** Every call, in order, as `list`, `read:<key>` or `create:<key>`. */
  calls: string[];
  signals: Array<AbortSignal | undefined>;
};

/**
 * `inner` behind a destination that records every call and lets a case
 * replace one operation — a failure, a hang, a competing writer. What is
 * stored stays what the real destination holds.
 */
export function trackDestination(
  inner: AnchorDestination,
  overrides: Partial<Pick<AnchorDestination, "create" | "read" | "list">> = {},
): TrackedDestination {
  const calls: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const dest: AnchorDestination = {
    name: inner.name,
    location: inner.location,
    create: (args) => {
      calls.push(`create:${args.artifactKey}`);
      signals.push(args.signal);
      return (overrides.create ?? ((a) => inner.create(a)))(args);
    },
    read: (key, signal) => {
      calls.push(`read:${key}`);
      signals.push(signal);
      return (overrides.read ?? ((k, s) => inner.read(k, s)))(key, signal);
    },
    list: (signal) => {
      calls.push("list");
      signals.push(signal);
      return (overrides.list ?? ((s) => inner.list(s)))(signal);
    },
  };
  return { dest, calls, signals };
}

export function createCalls(calls: readonly string[]): string[] {
  return calls.filter((call) => call.startsWith("create:"));
}
