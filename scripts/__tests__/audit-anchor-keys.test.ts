/**
 * scripts/audit-anchor-keys.ts through its exported `run`, with in-memory
 * destinations and captured streams; plus one spawn test per package.json
 * script string. The seed must never reach either stream: every case that
 * reads a key file checks both, and the public key printed beside it is the
 * positive control that the streams were captured at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run, type KeysDeps } from "../audit-anchor-keys";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";
import { InMemoryDestination } from "@/lib/audit/anchor-destinations/in-memory-destination";
import { createCalls, trackDestination } from "@/__tests__/helpers/anchor-manifest-fixtures";
import {
  ANCHOR_ARTIFACT_CONTENT_TYPE,
  STATEMENT_OP,
  publicKeyArtifactKey,
  statementArtifactKey,
} from "@/lib/audit/anchor-artifact-keys";
import {
  InvalidTypError,
  kidForPublicKey,
  publicKeyForSigningKey,
  verify,
  verifyStatement,
} from "@/lib/audit/anchor-manifest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

type Vectors = {
  key: { seedHex: string; publicKeyHex: string; kid: string };
  jws: Array<{ name: string; jws: string }>;
};
const VECTORS = JSON.parse(
  readFileSync(join(ROOT, "cli/src/__tests__/fixtures/audit-anchor-vectors.json"), "utf8"),
) as Vectors;
const SEED_HEX = VECTORS.key.seedHex;
const PUBLIC_HEX = VECTORS.key.publicKeyHex;
const KID = VECTORS.key.kid;
const MANIFEST_JWS = VECTORS.jws.find((v) => v.name === "valid manifest")!.jws;

// A second key, for rotation and for a manifest signed under another key.
const NEW_SEED_HEX = "43".repeat(32);
const NEW_PUBLIC = publicKeyForSigningKey(Buffer.from(NEW_SEED_HEX, "hex"));
const NEW_PUBLIC_HEX = NEW_PUBLIC.toString("hex");
const NEW_KID = kidForPublicKey(NEW_PUBLIC);

const DAY_1 = new Date("2026-03-04T10:00:00.000Z");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-anchor-keys-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function keyFile(name: string, seedHex: string, mode = 0o600, contents = `${seedHex}\n`): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return path;
}

function harness(destinations: AnchorDestination[] = [], now = DAY_1) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: KeysDeps = {
    destinations,
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    now: () => now,
  };
  return {
    deps,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    run: (...argv: string[]) => run(argv, deps),
  };
}

/** Neither stream carries a seed, and the public key printed instead is there. */
function expectNoSeed(h: ReturnType<typeof harness>, seedHex: string) {
  expect(h.stdout() + h.stderr()).not.toContain(seedHex);
}

const OLD_KEY = () => keyFile("old.key", SEED_HEX);

async function signedStatement(name: "rotation" | "chain-restart", at = DAY_1): Promise<string> {
  const out = join(dir, `${name}-${at.getTime()}.jws`);
  const h = harness([], at);
  const code =
    name === "rotation"
      ? await h.run("rotation-statement", "--old-key-file", OLD_KEY(), "--new-public-key", NEW_PUBLIC_HEX, "--out", out)
      : await h.run("chain-restart", "--key-file", OLD_KEY(), "--previous-none", "--out", out);
  expect(code).toBe(0);
  return out;
}

describe("dispatch and arguments", () => {
  it("exits 2 on no subcommand and on an unknown one", async () => {
    expect(await harness().run()).toBe(2);
    expect(await harness().run("emit-rotation-event")).toBe(2);
  });

  it("does not echo a positional argument, which could be a seed", async () => {
    const h = harness();
    expect(await h.run("kid", SEED_HEX)).toBe(2);
    expectNoSeed(h, SEED_HEX);
  });

  it("does not echo a seed passed as the value of a key-file flag", async () => {
    for (const argv of [["kid", "--key-file", SEED_HEX], ["rotation-statement", "--old-key-file", SEED_HEX, "--new-public-key", NEW_PUBLIC_HEX, "--out", join(dir, "x.jws")]]) {
      const h = harness();
      expect(await h.run(...argv)).toBe(1);
      expect(h.stderr()).toContain("ENOENT");
      expect(h.stderr()).toMatch(/--(old-)?key-file/);
      expectNoSeed(h, SEED_HEX);
    }
  });

  it("does not echo a seed passed as the value of --out when the write fails", async () => {
    const h = harness();
    expect(
      await h.run("rotation-statement", "--old-key-file", OLD_KEY(), "--new-public-key", NEW_PUBLIC_HEX, "--out", join(dir, SEED_HEX, "x.jws")),
    ).toBe(1);
    expect(h.stderr()).toContain("ENOENT");
    expect(h.stderr()).toContain("--out");
    expectNoSeed(h, SEED_HEX);
  });

  it("refuses an option the subcommand does not take", async () => {
    const h = harness();
    expect(await h.run("kid", "--key-file", OLD_KEY(), "--confirm")).toBe(2);
  });
});

describe("kid", () => {
  it("prints the public key and kid, never the seed", async () => {
    const h = harness();
    expect(await h.run("kid", "--key-file", OLD_KEY())).toBe(0);
    expect(h.stdout()).toContain(`publicKey=${PUBLIC_HEX}\n`);
    expect(h.stdout()).toContain(`kid=${KID}\n`);
    expectNoSeed(h, SEED_HEX);
  });

  it("requires --key-file", async () => {
    expect(await harness().run("kid")).toBe(2);
  });

  it("refuses a key file that is group- or world-readable, without printing the seed", async () => {
    for (const mode of [0o644, 0o640, 0o604, 0o660]) {
      const h = harness();
      expect(await h.run("kid", "--key-file", keyFile(`m${mode}.key`, SEED_HEX, mode))).toBe(1);
      expect(h.stderr()).toContain("mode 0600");
      expectNoSeed(h, SEED_HEX);
    }
  });

  it("refuses a key file that is not mode 0600 even when it is stricter", async () => {
    const h = harness();
    expect(await h.run("kid", "--key-file", keyFile("r.key", SEED_HEX, 0o400))).toBe(1);
  });

  it("refuses a directory and a missing file", async () => {
    mkdirSync(join(dir, "d"), { mode: 0o600 });
    expect(await harness().run("kid", "--key-file", join(dir, "d"))).toBe(1);
    expect(await harness().run("kid", "--key-file", join(dir, "absent"))).toBe(1);
  });

  it.each([
    ["too short", SEED_HEX.slice(1)],
    ["too long", `${SEED_HEX}0`],
    ["one non-hex char", `${SEED_HEX.slice(1)}g`],
  ])("refuses a key file that is %s, without echoing it", async (_name, text) => {
    const h = harness();
    expect(await h.run("kid", "--key-file", keyFile("bad.key", SEED_HEX, 0o600, text))).toBe(1);
    // Refused as text, before anything is derived from a truncated decode.
    expect(h.stderr()).toContain("must hold exactly 64 hex chars");
    expect(h.stdout() + h.stderr()).not.toContain(text);
  });

  it("reads a seed in upper-case hex as the same key as its lower-case form, as the publisher's env does", async () => {
    const lowerHex = "ab".repeat(32);
    const lower = harness();
    const upper = harness();
    expect(await lower.run("kid", "--key-file", keyFile("lower.key", lowerHex))).toBe(0);
    expect(await upper.run("kid", "--key-file", keyFile("upper.key", lowerHex.toUpperCase()))).toBe(0);

    expect(upper.stdout()).toBe(lower.stdout());
    expect(upper.stdout()).toContain(`kid=${kidForPublicKey(publicKeyForSigningKey(Buffer.from(lowerHex, "hex")))}\n`);
    expectNoSeed(upper, lowerHex.toUpperCase());
  });

  it("refuses a key file past the size bound", async () => {
    const h = harness();
    expect(await h.run("kid", "--key-file", keyFile("big.key", SEED_HEX, 0o600, `${SEED_HEX}\n${"x".repeat(200)}`))).toBe(1);
    expect(h.stderr()).toContain("larger than");
  });

  it("accepts a key file without a trailing newline", async () => {
    const h = harness();
    expect(await h.run("kid", "--key-file", keyFile("nonl.key", SEED_HEX, 0o600, SEED_HEX))).toBe(0);
  });

  it("reports whether the key is archived at each destination", async () => {
    const archived = new InMemoryDestination("archived");
    // As an earlier runbook archived it: the 64 chars, no newline.
    const bare = new InMemoryDestination("bare");
    const absent = new InMemoryDestination("absent");
    const different = new InMemoryDestination("different");
    const key = publicKeyArtifactKey(KID);
    await archived.create({ artifactBytes: Buffer.from(`${PUBLIC_HEX}\n`), artifactKey: key, contentType: ANCHOR_ARTIFACT_CONTENT_TYPE.PUBLIC_KEY });
    await bare.create({ artifactBytes: Buffer.from(PUBLIC_HEX), artifactKey: key, contentType: ANCHOR_ARTIFACT_CONTENT_TYPE.PUBLIC_KEY });
    await different.create({ artifactBytes: Buffer.from(`${NEW_PUBLIC_HEX}\n`), artifactKey: key, contentType: ANCHOR_ARTIFACT_CONTENT_TYPE.PUBLIC_KEY });
    const h = harness([archived, bare, absent, different]);
    expect(await h.run("kid", "--key-file", OLD_KEY())).toBe(0);
    expect(h.stdout()).toContain("archived[archived]=yes");
    expect(h.stdout()).toContain("archived[bare]=yes");
    expect(h.stdout()).toContain("archived[absent]=no");
    expect(h.stdout()).toContain("archived[different]=different");
  });
});

describe("publish-pubkey over an archive that already holds the key's object", () => {
  const key = publicKeyArtifactKey(KID);
  const args = ["publish-pubkey", "--public-key", PUBLIC_HEX, "--confirm"];

  async function holding(name: string, text: string) {
    const store = new InMemoryDestination(name);
    await store.create({ artifactBytes: Buffer.from(text), artifactKey: key, contentType: ANCHOR_ARTIFACT_CONTENT_TYPE.PUBLIC_KEY });
    return { store, ...trackDestination(store) };
  }

  it.each([
    ["the 64 chars with no newline, as an earlier runbook archived it", PUBLIC_HEX],
    ["the 65 bytes this command writes", `${PUBLIC_HEX}\n`],
  ])("reports %s as the same key: exit 0, no create, the stored bytes kept", async (_label, text) => {
    const taken = await holding("taken", text);
    const h = harness([taken.dest]);

    expect(await h.run(...args)).toBe(0);

    expect(h.stdout()).toContain("taken: exists (same key)");
    expect(createCalls(taken.calls)).toEqual([]);
    expect((await taken.store.read(key))?.toString()).toBe(text);
  });

  it.each([
    ["another key", `${NEW_PUBLIC_HEX}\n`],
    ["the key in upper case", `${PUBLIC_HEX.toUpperCase()}\n`],
    ["63 chars of the key", PUBLIC_HEX.slice(1)],
  ])("refuses over %s: exit 1 and no create on any destination", async (_label, text) => {
    const clean = trackDestination(new InMemoryDestination("clean"));
    const taken = await holding("taken", text);
    const h = harness([clean.dest, taken.dest]);

    expect(await h.run(...args)).toBe(1);

    expect(h.stderr()).toContain("taken already holds a different object");
    expect([...createCalls(clean.calls), ...createCalls(taken.calls)]).toEqual([]);
    expect((await taken.store.read(key))?.toString()).toBe(text);
  });

  it("fails on a stored object it cannot read, with no create on any destination", async () => {
    const clean = trackDestination(new InMemoryDestination("clean"));
    const unreadable = trackDestination(new InMemoryDestination("unreadable"), {
      read: async () => {
        throw Object.assign(new Error("denied"), { code: "AccessDenied" });
      },
    });
    const h = harness([clean.dest, unreadable.dest]);

    expect(await h.run(...args)).toBe(1);

    expect(h.stderr()).toContain("AccessDenied");
    expect([...createCalls(clean.calls), ...createCalls(unreadable.calls)]).toEqual([]);
  });

  it("a competing writer that stores the same key in the other form between the check and the create is success", async () => {
    const store = new InMemoryDestination("raced");
    const { dest } = trackDestination(store, {
      create: async (create) => {
        await store.create({ ...create, artifactBytes: Buffer.from(PUBLIC_HEX) });
        return store.create(create);
      },
    });
    const h = harness([dest]);

    expect(await h.run(...args)).toBe(0);

    expect(h.stdout()).toContain("raced: exists (same key)");
    expect((await store.read(key))?.toString()).toBe(PUBLIC_HEX);
  });
});

describe("publish-pubkey", () => {
  const key = publicKeyArtifactKey(KID);

  it("refuses without --confirm, after printing what it would write, and writes nothing", async () => {
    const dest = new InMemoryDestination("a");
    const h = harness([dest]);
    expect(await h.run("publish-pubkey", "--public-key", PUBLIC_HEX)).toBe(2);
    expect(h.stdout()).toContain(`kid=${KID}`);
    expect(h.stdout()).toContain(`publicKey=${PUBLIC_HEX}`);
    expect(h.stdout()).toContain("destination=a");
    expect(h.stderr()).toContain("--confirm");
    expect(await dest.list()).toEqual([]);
  });

  it("creates public-keys/<kid>.pub on every destination with --confirm", async () => {
    const a = new InMemoryDestination("a");
    const b = new InMemoryDestination("b");
    const h = harness([a, b]);
    expect(await h.run("publish-pubkey", "--public-key", PUBLIC_HEX, "--confirm")).toBe(0);
    for (const d of [a, b]) expect((await d.read(key))?.toString()).toBe(`${PUBLIC_HEX}\n`);
  });

  it("derives the public key from a key file and never prints the seed", async () => {
    const dest = new InMemoryDestination();
    const h = harness([dest]);
    expect(await h.run("publish-pubkey", "--key-file", OLD_KEY(), "--confirm")).toBe(0);
    expect(await dest.list()).toEqual([key]);
    expectNoSeed(h, SEED_HEX);
  });

  it("treats the key it archived itself as already there", async () => {
    const dest = new InMemoryDestination();
    expect(await harness([dest]).run("publish-pubkey", "--public-key", PUBLIC_HEX, "--confirm")).toBe(0);
    const h = harness([dest]);
    expect(await h.run("publish-pubkey", "--public-key", PUBLIC_HEX, "--confirm")).toBe(0);
    expect(h.stdout()).toContain("exists (same key)");
  });

  it("exits 1 and writes to no destination when one holds different bytes", async () => {
    const clean = new InMemoryDestination("clean");
    const taken = new InMemoryDestination("taken");
    await taken.create({ artifactBytes: Buffer.from(`${NEW_PUBLIC_HEX}\n`), artifactKey: key, contentType: ANCHOR_ARTIFACT_CONTENT_TYPE.PUBLIC_KEY });
    const h = harness([clean, taken]);
    expect(await h.run("publish-pubkey", "--public-key", PUBLIC_HEX, "--confirm")).toBe(1);
    expect(h.stderr()).toContain("taken");
    expect(await clean.list()).toEqual([]);
    expect((await taken.read(key))?.toString()).toBe(`${NEW_PUBLIC_HEX}\n`);
  });

  it("exits 1 when a competing writer takes the key between the check and the create", async () => {
    class RacedDestination extends InMemoryDestination {
      override async create(args: Parameters<InMemoryDestination["create"]>[0]) {
        await super.create({ ...args, artifactBytes: Buffer.from(`${NEW_PUBLIC_HEX}\n`) });
        return super.create(args);
      }
    }
    const dest = new RacedDestination("raced");
    const h = harness([dest]);
    expect(await h.run("publish-pubkey", "--public-key", PUBLIC_HEX, "--confirm")).toBe(1);
    expect(h.stderr()).toContain("raced");
    expect((await dest.read(key))?.toString()).toBe(`${NEW_PUBLIC_HEX}\n`);
  });

  it("requires exactly one of --key-file and --public-key", async () => {
    const dest = new InMemoryDestination();
    expect(await harness([dest]).run("publish-pubkey", "--confirm")).toBe(2);
    expect(await harness([dest]).run("publish-pubkey", "--key-file", OLD_KEY(), "--public-key", PUBLIC_HEX, "--confirm")).toBe(2);
    expect(await dest.list()).toEqual([]);
  });

  it("refuses a malformed --public-key", async () => {
    const dest = new InMemoryDestination();
    expect(await harness([dest]).run("publish-pubkey", "--public-key", PUBLIC_HEX.toUpperCase(), "--confirm")).toBe(2);
    expect(await harness([dest]).run("publish-pubkey", "--public-key", PUBLIC_HEX.slice(1), "--confirm")).toBe(2);
    expect(await dest.list()).toEqual([]);
  });

  it("refuses a key file in a loose mode before writing anything", async () => {
    const dest = new InMemoryDestination();
    const h = harness([dest]);
    expect(await h.run("publish-pubkey", "--key-file", keyFile("loose.key", SEED_HEX, 0o644), "--confirm")).toBe(1);
    expect(await dest.list()).toEqual([]);
    expectNoSeed(h, SEED_HEX);
  });

  it("refuses when no destination is configured", async () => {
    expect(await harness([]).run("publish-pubkey", "--public-key", PUBLIC_HEX, "--confirm")).toBe(2);
  });
});

describe("rotation-statement", () => {
  it("writes a statement the old key's public key verifies, naming both kids and the new key", async () => {
    const out = await signedStatement("rotation");
    const h = harness();
    const jws = readFileSync(out, "utf8").trim();
    const payload = JSON.parse(verifyStatement(jws, publicKeyForSigningKey(Buffer.from(SEED_HEX, "hex"))).toString());
    expect(payload).toEqual({
      op: "rotation",
      oldKid: KID,
      newKid: NEW_KID,
      newPublicKey: NEW_PUBLIC_HEX,
      issuedAt: DAY_1.toISOString(),
    });
    expectNoSeed(h, SEED_HEX);
  });

  it("produces a statement a manifest verify rejects by typ", async () => {
    const jws = readFileSync(await signedStatement("rotation"), "utf8").trim();
    expect(() => verify(jws, publicKeyForSigningKey(Buffer.from(SEED_HEX, "hex")))).toThrow(InvalidTypError);
  });

  it("prints no seed and refuses a loose key file", async () => {
    const h = harness();
    const out = join(dir, "x.jws");
    expect(await h.run("rotation-statement", "--old-key-file", keyFile("l.key", SEED_HEX, 0o644), "--new-public-key", NEW_PUBLIC_HEX, "--out", out)).toBe(1);
    expect(existsSync(out)).toBe(false);
    expectNoSeed(h, SEED_HEX);
  });

  it("refuses to overwrite an existing --out", async () => {
    const out = await signedStatement("rotation");
    const before = readFileSync(out, "utf8");
    const h = harness();
    expect(await h.run("rotation-statement", "--old-key-file", OLD_KEY(), "--new-public-key", NEW_PUBLIC_HEX, "--out", out)).toBe(1);
    expect(readFileSync(out, "utf8")).toBe(before);
  });

  it("requires all three options and a well-formed new public key", async () => {
    const out = join(dir, "y.jws");
    expect(await harness().run("rotation-statement", "--old-key-file", OLD_KEY(), "--out", out)).toBe(2);
    expect(await harness().run("rotation-statement", "--old-key-file", OLD_KEY(), "--new-public-key", "abc", "--out", out)).toBe(2);
    expect(existsSync(out)).toBe(false);
  });
});

describe("chain-restart", () => {
  const manifestFile = () => {
    const path = join(dir, "previous.jws");
    writeFileSync(path, `${MANIFEST_JWS}\n`);
    return path;
  };
  const payloadOf = (out: string) =>
    JSON.parse(verifyStatement(readFileSync(out, "utf8").trim(), publicKeyForSigningKey(Buffer.from(SEED_HEX, "hex"))).toString());

  it("signs the previous manifest's hash and uri when it verifies under the signing key", async () => {
    const out = join(dir, "restart.jws");
    const h = harness();
    expect(await h.run("chain-restart", "--key-file", OLD_KEY(), "--previous-manifest", manifestFile(), "--previous-uri", "s3://bucket/old/2026-01-15.jws", "--out", out)).toBe(0);
    const manifest = verify(MANIFEST_JWS, publicKeyForSigningKey(Buffer.from(SEED_HEX, "hex")));
    const payloadBytes = Buffer.from(MANIFEST_JWS.split(".")[1], "base64url");
    expect(manifest.anchoredAt).toBe("2026-01-15T00:05:00.000Z");
    expect(payloadOf(out)).toEqual({
      op: "chain-restart",
      previousChain: { uri: "s3://bucket/old/2026-01-15.jws", sha256: createHash("sha256").update(payloadBytes).digest("hex") },
      issuedAt: DAY_1.toISOString(),
    });
    expectNoSeed(h, SEED_HEX);
  });

  it.each([
    ["version 1, as earlier releases wrote it", "valid manifest", 1],
    ["version 2, bound to its chain location", "valid version 2 manifest", 2],
  ])("accepts a previous manifest of format %s", async (_label, vector, version) => {
    const jws = VECTORS.jws.find((v) => v.name === vector)!.jws;
    expect(verify(jws, publicKeyForSigningKey(Buffer.from(SEED_HEX, "hex"))).version).toBe(version);
    const file = join(dir, "previous.jws");
    writeFileSync(file, `${jws}\n`);
    const out = join(dir, "restart.jws");

    expect(await harness().run("chain-restart", "--key-file", OLD_KEY(), "--previous-manifest", file, "--previous-uri", "u", "--out", out)).toBe(0);
    expect(payloadOf(out).previousChain).toEqual({
      uri: "u",
      sha256: createHash("sha256").update(Buffer.from(jws.split(".")[1], "base64url")).digest("hex"),
    });
  });

  it("refuses a version 2 previous manifest that carries no chain location and writes no statement", async () => {
    const file = join(dir, "previous.jws");
    writeFileSync(file, `${VECTORS.jws.find((v) => v.name === "version 2 without a chainLocation")!.jws}\n`);
    const out = join(dir, "restart.jws");
    const h = harness();

    expect(await h.run("chain-restart", "--key-file", OLD_KEY(), "--previous-manifest", file, "--previous-uri", "u", "--out", out)).toBe(1);
    expect(h.stderr()).toContain("does not verify");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a previous manifest that does not verify and writes no statement", async () => {
    const [header, payload, signature] = MANIFEST_JWS.split(".");
    const tampered = `${header}.${payload}.${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
    const file = join(dir, "tampered.jws");
    writeFileSync(file, tampered);
    const out = join(dir, "restart.jws");
    const h = harness();
    expect(await h.run("chain-restart", "--key-file", OLD_KEY(), "--previous-manifest", file, "--previous-uri", "u", "--out", out)).toBe(1);
    expect(h.stderr()).toContain("does not verify");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a previous manifest signed under another key unless that key is passed, and then accepts it", async () => {
    const out = join(dir, "restart.jws");
    const newKey = keyFile("new.key", NEW_SEED_HEX);
    const args = ["chain-restart", "--key-file", newKey, "--previous-manifest", manifestFile(), "--previous-uri", "u", "--out", out];
    const refused = harness();
    expect(await refused.run(...args)).toBe(1);
    expect(refused.stderr()).toContain("--previous-public-key");
    expect(existsSync(out)).toBe(false);

    const pub = join(dir, "old.pub");
    writeFileSync(pub, `${PUBLIC_HEX}\n`);
    expect(await harness().run(...args, "--previous-public-key", pub)).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it("refuses a previous public key that is not the one the manifest names", async () => {
    const pub = join(dir, "wrong.pub");
    writeFileSync(pub, `${NEW_PUBLIC_HEX}\n`);
    const out = join(dir, "restart.jws");
    expect(await harness().run("chain-restart", "--key-file", OLD_KEY(), "--previous-manifest", manifestFile(), "--previous-uri", "u", "--previous-public-key", pub, "--out", out)).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it("accepts --previous-none and records a null previous chain", async () => {
    const out = join(dir, "restart.jws");
    expect(await harness().run("chain-restart", "--key-file", OLD_KEY(), "--previous-none", "--out", out)).toBe(0);
    expect(payloadOf(out)).toEqual({ op: "chain-restart", previousChain: null, issuedAt: DAY_1.toISOString() });
  });

  it("requires exactly one of --previous-none and a previous manifest with its uri", async () => {
    const out = join(dir, "restart.jws");
    const base = ["chain-restart", "--key-file", OLD_KEY(), "--out", out];
    expect(await harness().run(...base)).toBe(2);
    expect(await harness().run(...base, "--previous-manifest", manifestFile())).toBe(2);
    expect(await harness().run(...base, "--previous-uri", "u")).toBe(2);
    expect(await harness().run(...base, "--previous-none", "--previous-uri", "u")).toBe(2);
    expect(await harness().run(...base, "--previous-none", "--previous-manifest", manifestFile(), "--previous-uri", "u")).toBe(2);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a loose key file", async () => {
    const h = harness();
    expect(await h.run("chain-restart", "--key-file", keyFile("l.key", SEED_HEX, 0o644), "--previous-none", "--out", join(dir, "o.jws"))).toBe(1);
    expectNoSeed(h, SEED_HEX);
  });
});

describe("publish-statement", () => {
  const rotationKey = statementArtifactKey(DAY_1, STATEMENT_OP.ROTATION, KID);
  const restartKey = statementArtifactKey(DAY_1, STATEMENT_OP.CHAIN_RESTART, KID);

  it("refuses without --confirm and writes nothing", async () => {
    const dest = new InMemoryDestination();
    const file = await signedStatement("rotation");
    const h = harness([dest]);
    expect(await h.run("publish-statement", "--file", file, "--public-key", PUBLIC_HEX)).toBe(2);
    expect(h.stdout()).toContain(`artifact=${rotationKey}`);
    expect(await dest.list()).toEqual([]);
  });

  it("creates the statement at its op-and-day key, with the signer from the archive when --public-key is absent", async () => {
    const dest = new InMemoryDestination();
    const file = await signedStatement("rotation");
    expect(await harness([dest]).run("publish-statement", "--file", file, "--confirm")).toBe(1);
    expect(await dest.list()).toEqual([]);

    expect(await harness([dest]).run("publish-pubkey", "--public-key", PUBLIC_HEX, "--confirm")).toBe(0);
    expect(await harness([dest]).run("publish-statement", "--file", file, "--confirm")).toBe(0);
    expect((await dest.read(rotationKey))?.toString()).toBe(readFileSync(file, "utf8").trim());
  });

  it("lands a rotation and a chain-restart statement of one day on different keys", async () => {
    const dest = new InMemoryDestination();
    for (const name of ["rotation", "chain-restart"] as const) {
      const file = await signedStatement(name);
      expect(await harness([dest]).run("publish-statement", "--file", file, "--public-key", PUBLIC_HEX, "--confirm")).toBe(0);
    }
    expect((await dest.list()).sort()).toEqual([restartKey, rotationKey].sort());
  });

  it("succeeds when the same file is published twice", async () => {
    const dest = new InMemoryDestination();
    const file = await signedStatement("rotation");
    const args = ["publish-statement", "--file", file, "--public-key", PUBLIC_HEX, "--confirm"];
    expect(await harness([dest]).run(...args)).toBe(0);
    const again = harness([dest]);
    expect(await again.run(...args)).toBe(0);
    expect(again.stdout()).toContain("exists (identical)");
    expect(await dest.list()).toEqual([rotationKey]);
  });

  it("exits 1 naming the stored key when a different statement of the same op, day and signer exists", async () => {
    const dest = new InMemoryDestination();
    const first = await signedStatement("rotation", DAY_1);
    const second = await signedStatement("rotation", new Date(DAY_1.getTime() + 1000));
    const stored = (await (async () => {
      expect(await harness([dest]).run("publish-statement", "--file", first, "--public-key", PUBLIC_HEX, "--confirm")).toBe(0);
      return dest.read(rotationKey);
    })())!;
    const h = harness([dest]);
    expect(await h.run("publish-statement", "--file", second, "--public-key", PUBLIC_HEX, "--confirm")).toBe(1);
    expect(h.stderr()).toContain(rotationKey);
    expect((await dest.read(rotationKey))!.equals(stored)).toBe(true);
  });

  it("writes to no destination when one of them holds a different statement", async () => {
    const clean = new InMemoryDestination("clean");
    const taken = new InMemoryDestination("taken");
    await taken.create({ artifactBytes: Buffer.from("other"), artifactKey: rotationKey, contentType: ANCHOR_ARTIFACT_CONTENT_TYPE.JWS });
    const file = await signedStatement("rotation");
    expect(await harness([clean, taken]).run("publish-statement", "--file", file, "--public-key", PUBLIC_HEX, "--confirm")).toBe(1);
    expect(await clean.list()).toEqual([]);
  });

  it("refuses a tampered statement with zero creates, and accepts its untampered twin", async () => {
    const dest = new InMemoryDestination();
    const file = await signedStatement("rotation");
    const jws = readFileSync(file, "utf8").trim();
    const [header, payload, signature] = jws.split(".");
    const forged = JSON.parse(Buffer.from(payload, "base64url").toString());
    forged.newKid = KID;
    const tampered = join(dir, "tampered.jws");
    writeFileSync(tampered, `${header}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}\n`);

    const h = harness([dest]);
    expect(await h.run("publish-statement", "--file", tampered, "--public-key", PUBLIC_HEX, "--confirm")).toBe(1);
    expect(h.stderr()).toContain("does not verify");
    expect(await dest.list()).toEqual([]);

    expect(await harness([dest]).run("publish-statement", "--file", file, "--public-key", PUBLIC_HEX, "--confirm")).toBe(0);
  });

  it("refuses a manifest JWS with zero creates", async () => {
    const dest = new InMemoryDestination();
    const file = join(dir, "manifest.jws");
    writeFileSync(file, MANIFEST_JWS);
    const h = harness([dest]);
    expect(await h.run("publish-statement", "--file", file, "--public-key", PUBLIC_HEX, "--confirm")).toBe(1);
    expect(h.stderr()).toContain("InvalidTypError");
    expect(await dest.list()).toEqual([]);
  });

  it("prints no control character from a hostile header typ", async () => {
    const [header, payload, signature] = readFileSync(await signedStatement("rotation"), "utf8").trim().split(".");
    const hostileHeader = { ...JSON.parse(Buffer.from(header, "base64url").toString()), typ: "\u001b[31mred\nline" };
    const file = join(dir, "hostile.jws");
    writeFileSync(file, `${Buffer.from(JSON.stringify(hostileHeader)).toString("base64url")}.${payload}.${signature}\n`);

    const h = harness([new InMemoryDestination()]);
    expect(await h.run("publish-statement", "--file", file, "--public-key", PUBLIC_HEX, "--confirm")).toBe(1);
    expect(h.stderr()).toContain("InvalidTypError");
    expect([...(h.stdout() + h.stderr())].filter((c) => c.charCodeAt(0) < 0x20 && c !== "\n")).toEqual([]);
    expect(h.stderr()).not.toContain("red");
  });

  it("refuses a statement checked under a key its kid does not name", async () => {
    const dest = new InMemoryDestination();
    const file = await signedStatement("rotation");
    const h = harness([dest]);
    expect(await h.run("publish-statement", "--file", file, "--public-key", NEW_PUBLIC_HEX, "--confirm")).toBe(1);
    expect(h.stderr()).toContain("KidMismatchError");
    expect(await dest.list()).toEqual([]);
  });

  it("refuses a file that is not a JWS", async () => {
    const file = join(dir, "junk");
    writeFileSync(file, "not a jws");
    expect(await harness([new InMemoryDestination()]).run("publish-statement", "--file", file, "--public-key", PUBLIC_HEX, "--confirm")).toBe(1);
  });
});

describe("package.json scripts, run as processes", () => {
  const TSX = resolve(ROOT, "node_modules/.bin/tsx");
  const CASE_TIMEOUT_MS = 30_000;
  const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
  const NAMES = [
    "audit-anchor-kid",
    "audit-anchor-publish-pubkey",
    "audit-anchor-rotation-statement",
    "audit-anchor-chain-restart",
    "audit-anchor-publish-statement",
  ];

  /** The script string's own argv (`tsx <file> <subcommand>`), then the operator's arguments. */
  function spawnScript(name: string, args: string[], fsPath = "") {
    const words = scripts[name].split(" ");
    expect(words[0]).toBe("tsx");
    return spawnSync(TSX, [...words.slice(1), ...args], {
      cwd: ROOT,
      // Empty destination variables stay empty under load-env, so no .env reaches a real bucket.
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        AUDIT_ANCHOR_DESTINATION_S3_BUCKET: "",
        AUDIT_ANCHOR_DESTINATION_GH_REPO: "",
        AUDIT_ANCHOR_DESTINATION_FS_PATH: fsPath,
      },
      encoding: "utf8",
      timeout: CASE_TIMEOUT_MS - 5_000,
    });
  }

  it("audit-anchor-kid prints the vector's public key and kid and no seed", () => {
    const r = spawnScript("audit-anchor-kid", ["--key-file", keyFile("spawn.key", SEED_HEX)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`publicKey=${PUBLIC_HEX}`);
    expect(r.stdout).toContain(`kid=${KID}`);
    expect(r.stdout + r.stderr).not.toContain(SEED_HEX);
  }, CASE_TIMEOUT_MS);

  it("with a filesystem destination from the environment: publish-pubkey archives the key, a second run finds it, and kid reports it archived", () => {
    // `dir` is the per-case temp dir, removed in afterEach.
    const archive = join(dir, "anchors");
    const publish = () => spawnScript("audit-anchor-publish-pubkey", ["--public-key", PUBLIC_HEX, "--confirm"], archive);

    const first = publish();
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("filesystem: created");
    expect(readFileSync(join(archive, "public-keys", `${KID}.pub`), "utf8")).toBe(`${PUBLIC_HEX}\n`);

    const second = publish();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("filesystem: exists (same key)");

    const kid = spawnScript("audit-anchor-kid", ["--key-file", keyFile("spawn.key", SEED_HEX)], archive);
    expect(kid.status).toBe(0);
    expect(kid.stdout).toContain("archived[filesystem]=yes");
  }, 3 * CASE_TIMEOUT_MS);

  it.each(NAMES.filter((n) => n !== "audit-anchor-kid"))("%s with no arguments ends in its argument error", (name) => {
    const r = spawnScript(name, []);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  }, CASE_TIMEOUT_MS);

  it("all five scripts are present", () => {
    for (const name of NAMES) expect(scripts[name]).toMatch(/^tsx scripts\/audit-anchor-keys\.ts [a-z-]+$/);
  });
});
