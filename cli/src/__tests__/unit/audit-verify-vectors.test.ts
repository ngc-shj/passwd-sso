/**
 * audit-verify against the vector file the server's anchor-manifest module is
 * held to as well (src/lib/audit/anchor-manifest.unit.test.ts reads the same
 * file), and the rules only the CLI has: which URLs it fetches, and which key
 * a prior manifest is checked under.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";
import { AUDIT_ANCHOR_KID_PREFIX, AUDIT_ANCHOR_TYP } from "../../constants/audit-anchor.js";
import * as auditVerify from "../../commands/audit-verify.js";

const {
  auditVerifyCommand,
  ChainBreakError,
  InsecureUrlError,
  InvalidPublicKeyError,
  KidMismatchError,
  PriorPublicKeyRequiredError,
} = auditVerify;

type Vectors = {
  key: { seedHex: string; publicKeyHex: string; kid: string };
  manifest: Record<string, unknown>;
  jws: Array<{ name: string; jws: string; expect: string }>;
  publicKeyTexts: Array<{ name: string; text: string; valid: boolean }>;
  urls: Array<{ name: string; url: string; allowed: boolean }>;
};

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const VECTORS = JSON.parse(readFileSync(join(FIXTURES, "audit-anchor-vectors.json"), "utf8")) as Vectors;
const VALID_JWS = VECTORS.jws.find((v) => v.expect === "ok")!.jws;

// --- Signing helpers (the CLI holds no signer of its own) ---

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX_LEN = 12;

function keyFor(seedByte: number) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.alloc(32, seedByte)]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = (createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer).subarray(
    ED25519_SPKI_PREFIX_LEN,
  );
  return {
    privateKey,
    publicKeyHex: publicKey.toString("hex"),
    kid: `${AUDIT_ANCHOR_KID_PREFIX}${publicKey.subarray(0, 8).toString("hex")}`,
  };
}

/** JCS for the value shapes a manifest holds: sorted keys, no whitespace. */
function canonical(manifest: Record<string, unknown>): string {
  const sortKeys = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sortKeys)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort()
              .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
          )
        : value;
  return JSON.stringify(sortKeys(manifest));
}

function signManifest(manifest: Record<string, unknown>, key: ReturnType<typeof keyFor>): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: key.kid, typ: AUDIT_ANCHOR_TYP })).toString("base64url");
  const payload = Buffer.from(canonical(manifest)).toString("base64url");
  const signature = nodeSign(null, Buffer.from(`${header}.${payload}`), key.privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

// --- Fixture plumbing ---

let tmpDir: string;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.spyOn>;

function file(name: string, content: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, content);
  return path;
}

function printed(): string {
  return stdout.mock.calls.map((c: unknown[]) => String(c[0])).join("");
}

function warned(): string {
  return stderr.mock.calls.map((c: unknown[]) => String(c[0])).join("");
}

function controlCharsOf(text: string): string[] {
  return [...text].filter((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
}

/** Serve `bodies` by URL; anything else answers 404. */
function serve(bodies: Record<string, string>): void {
  fetchSpy.mockImplementation(async (input: string | URL | Request) => {
    const body = bodies[String(input)];
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200 });
  });
}

async function outcomeOf(run: Promise<void>): Promise<string> {
  return run.then(
    () => "ok",
    (err: unknown) => (err as Error).name,
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "audit-verify-vectors-"));
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  fetchSpy = vi.spyOn(globalThis, "fetch");
  vi.stubEnv("AUDIT_ANCHOR_PUBLIC_KEY_ARCHIVE_URL", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("the vector file", () => {
  it("is what its recorded generator produces", () => {
    // Throws (non-zero exit) when the checked-in file differs.
    execFileSync(process.execPath, [join(FIXTURES, "generate-audit-anchor-vectors.mjs"), "--check"], { stdio: "pipe" });
  });

  it("names a kid that is the prefix and the public key's first 8 bytes in hex", () => {
    expect(VECTORS.key.kid).toBe(`${AUDIT_ANCHOR_KID_PREFIX}${VECTORS.key.publicKeyHex.slice(0, 16)}`);
    expect(keyFor(0x42)).toMatchObject({ publicKeyHex: VECTORS.key.publicKeyHex, kid: VECTORS.key.kid });
  });
});

describe("audit-verify — shared JWS vectors", () => {
  it.each(VECTORS.jws)("$name → $expect", async ({ jws, expect: expected }) => {
    const outcome = await outcomeOf(
      auditVerifyCommand({ manifest: file("m.jws", jws), publicKey: file("key.pub", VECTORS.key.publicKeyHex) }),
    );

    expect(outcome).toBe(expected);
    expect(printed().includes("PASS")).toBe(expected === "ok");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("exports the error a mismatched kid raises, for the exit code", () => {
    expect(VECTORS.jws.some((v) => v.expect === KidMismatchError.name)).toBe(true);
  });

  it.each(VECTORS.jws.filter((v) => v.expect !== "ok"))("$name: the error message carries no control character", async ({ jws }) => {
    const err = await auditVerifyCommand({
      manifest: file("m.jws", jws),
      publicKey: file("key.pub", VECTORS.key.publicKeyHex),
    }).then(
      () => new Error("verified"),
      (e: unknown) => e as Error,
    );

    expect(controlCharsOf(err.message)).toEqual([]);
  });

  it("the vectors include a kid that carries control characters, quoted in the message", async () => {
    const hostile = VECTORS.jws.filter((v) => {
      const header = JSON.parse(Buffer.from(v.jws.split(".")[0], "base64url").toString("utf8")) as { kid?: unknown } | null;
      return typeof header?.kid === "string" && controlCharsOf(header.kid).length > 0;
    });
    expect(hostile.map((v) => v.expect)).toEqual(["InvalidKidError"]);

    const kid = (JSON.parse(Buffer.from(hostile[0].jws.split(".")[0], "base64url").toString("utf8")) as { kid: string }).kid;
    await expect(
      auditVerifyCommand({ manifest: file("m.jws", hostile[0].jws), publicKey: file("key.pub", VECTORS.key.publicKeyHex) }),
    ).rejects.toThrow(JSON.stringify(kid));
  });
});

describe("audit-verify — an unverified header in an error message", () => {
  it.each(["alg", "typ"])("keeps control characters of a hostile %s out of the message", async (field) => {
    const [headerB64, payloadB64, signature] = VALID_JWS.split(".");
    const header = { ...JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")), [field]: "\u001b[31mred\nline" };
    const hostile = [Buffer.from(JSON.stringify(header)).toString("base64url"), payloadB64, signature].join(".");

    const err = await auditVerifyCommand({
      manifest: file("m.jws", hostile),
      publicKey: file("key.pub", VECTORS.key.publicKeyHex),
    }).then(
      () => new Error("verified"),
      (e: unknown) => e as Error,
    );

    expect(err.message).toContain("Invalid JWS");
    expect(controlCharsOf(err.message)).toEqual([]);
  });
});

describe("audit-verify — public key text", () => {
  it.each(VECTORS.publicKeyTexts)("--public-key file holding $name → valid: $valid", async ({ text, valid }) => {
    const outcome = await outcomeOf(
      auditVerifyCommand({ manifest: file("m.jws", VALID_JWS), publicKey: file("key.pub", text) }),
    );

    expect(outcome).toBe(valid ? "ok" : InvalidPublicKeyError.name);
  });

  it.each(VECTORS.publicKeyTexts)("archive answering $name → valid: $valid", async ({ text, valid }) => {
    serve({ [`https://archive.example.com/keys/${VECTORS.key.kid}.pub`]: text });

    const outcome = await outcomeOf(
      auditVerifyCommand({ manifest: file("m.jws", VALID_JWS), archiveUrl: "https://archive.example.com/keys" }),
    );

    expect(outcome).toBe(valid ? "ok" : InvalidPublicKeyError.name);
  });
});

describe("audit-verify — which URLs it fetches", () => {
  it.each(VECTORS.urls)("manifest URL, $name → allowed: $allowed", async ({ url, allowed }) => {
    const manifestUrl = `${url}manifests/m.jws`;
    serve({ [new URL(manifestUrl).href]: VALID_JWS });

    const outcome = await outcomeOf(
      auditVerifyCommand({ manifest: manifestUrl, publicKey: file("key.pub", VECTORS.key.publicKeyHex) }),
    );

    if (allowed) {
      expect(outcome).toBe("ok");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } else {
      expect(outcome).toBe(InsecureUrlError.name);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it.each(VECTORS.urls)("archive URL, $name → allowed: $allowed", async ({ url, allowed }) => {
    const archiveUrl = `${url}keys`;
    if (allowed) serve({ [`${new URL(archiveUrl).href}/${VECTORS.key.kid}.pub`]: VECTORS.key.publicKeyHex });

    const outcome = await outcomeOf(auditVerifyCommand({ manifest: file("m.jws", VALID_JWS), archiveUrl }));

    if (allowed) {
      expect(outcome).toBe("ok");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } else {
      expect(outcome).toBe(InsecureUrlError.name);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it("covers both outcomes, the three loopback hosts and the two look-alikes", () => {
    const allowed = VECTORS.urls.filter((v) => v.allowed).map((v) => v.url);
    const denied = VECTORS.urls.filter((v) => !v.allowed).map((v) => v.url);
    expect(allowed).toEqual(
      expect.arrayContaining(["http://localhost:8080/", "http://127.0.0.1:8080/", "http://[::1]:8080/"]),
    );
    expect(denied).toEqual(
      expect.arrayContaining(["http://127.0.0.1.example.com/", "http://127.0.0.1@example.com/"]),
    );
  });

  it("reads a manifest argument without a scheme as a file path", async () => {
    await expect(
      auditVerifyCommand({ manifest: join(tmpDir, "absent.jws"), publicKey: file("key.pub", VECTORS.key.publicKeyHex) }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("audit-verify — the prior manifest's key", () => {
  const current = keyFor(0x42);
  const retired = keyFor(0x51);
  const ARCHIVE = "https://archive.example.com/keys";

  const priorBody = { ...VECTORS.manifest, anchoredAt: "2026-01-14T00:05:00.000Z" };
  const chainedTo = (prior: Record<string, unknown>) => ({
    ...VECTORS.manifest,
    previousManifest: {
      uri: "s3-object-lock://prior.jws",
      sha256: createHash("sha256").update(canonical(prior)).digest("hex"),
    },
  });
  const currentJws = signManifest(chainedTo(priorBody), current);

  function serveArchive(): void {
    serve({
      [`${ARCHIVE}/${current.kid}.pub`]: current.publicKeyHex,
      [`${ARCHIVE}/${retired.kid}.pub`]: retired.publicKeyHex,
    });
  }

  it("same kid as the current manifest: checked under the current key, with no prior key given", async () => {
    await auditVerifyCommand({
      manifest: file("m.jws", currentJws),
      publicKey: file("key.pub", current.publicKeyHex),
      priorManifest: file("prior.jws", signManifest(priorBody, current)),
      archiveUrl: ARCHIVE,
    });

    expect(printed()).toContain("PASS");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("another kid with --prior-public-key: checked under that key, the archive not consulted", async () => {
    await auditVerifyCommand({
      manifest: file("m.jws", currentJws),
      publicKey: file("key.pub", current.publicKeyHex),
      priorManifest: file("prior.jws", signManifest(priorBody, retired)),
      priorPublicKey: file("retired.pub", retired.publicKeyHex),
      archiveUrl: ARCHIVE,
    });

    expect(printed()).toContain("PASS");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("another kid, current key from the archive: the prior key comes from the archive too", async () => {
    serveArchive();

    await auditVerifyCommand({
      manifest: file("m.jws", currentJws),
      priorManifest: file("prior.jws", signManifest(priorBody, retired)),
      archiveUrl: ARCHIVE,
    });

    expect(printed()).toContain("PASS");
    expect(fetchSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
      `${ARCHIVE}/${current.kid}.pub`,
      `${ARCHIVE}/${retired.kid}.pub`,
    ]);
  });

  it("another kid, current key from --public-key: refuses, naming --prior-public-key, without asking the archive", async () => {
    serveArchive();

    const error = await auditVerifyCommand({
      manifest: file("m.jws", currentJws),
      publicKey: file("key.pub", current.publicKeyHex),
      priorManifest: file("prior.jws", signManifest(priorBody, retired)),
      archiveUrl: ARCHIVE,
    }).then(
      () => null,
      (err: unknown) => err as Error,
    );

    expect(error).toBeInstanceOf(PriorPublicKeyRequiredError);
    expect(error?.message).toContain("--prior-public-key");
    expect(error?.message).toContain(retired.kid);
    expect(printed()).not.toContain("PASS");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a --prior-public-key that is not the prior manifest's key is a kid mismatch", async () => {
    await expect(
      auditVerifyCommand({
        manifest: file("m.jws", currentJws),
        publicKey: file("key.pub", current.publicKeyHex),
        priorManifest: file("prior.jws", signManifest(priorBody, retired)),
        priorPublicKey: file("wrong.pub", current.publicKeyHex),
      }),
    ).rejects.toBeInstanceOf(KidMismatchError);
  });

  it("still reports a chain break across a rotation, once the prior manifest verifies", async () => {
    const other = { ...priorBody, deploymentId: "another-deployment" };

    await expect(
      auditVerifyCommand({
        manifest: file("m.jws", currentJws),
        publicKey: file("key.pub", current.publicKeyHex),
        priorManifest: file("prior.jws", signManifest(other, retired)),
        priorPublicKey: file("retired.pub", retired.publicKeyHex),
      }),
    ).rejects.toBeInstanceOf(ChainBreakError);
  });
});

describe("audit-verify — a tenant's epoch between the prior and the current manifest", () => {
  const key = keyFor(0x42);
  const TAG = "6db2cb938b211a0b0824844113d78dd8aaafbeb608b6a2fc3903aa5114c03323";
  const tenant = (epoch: number, chainSeq: string) => ({ tenantTag: TAG, chainSeq, prevHash: "ab".repeat(32), epoch });

  /** Verify a current manifest holding `current`, chained to a prior one holding `prior`. */
  async function verifyPair(prior: ReturnType<typeof tenant>, current: ReturnType<typeof tenant>): Promise<void> {
    const priorBody = { ...VECTORS.manifest, anchoredAt: "2026-01-14T00:05:00.000Z", tenants: [prior] };
    const currentBody = {
      ...VECTORS.manifest,
      tenants: [current],
      previousManifest: {
        uri: "s3-object-lock://prior.jws",
        sha256: createHash("sha256").update(canonical(priorBody)).digest("hex"),
      },
    };
    await auditVerifyCommand({
      manifest: file("m.jws", signManifest(currentBody, key)),
      publicKey: file("key.pub", key.publicKeyHex),
      priorManifest: file("prior.jws", signManifest(priorBody, key)),
    });
  }

  it.each([
    ["raised", 1, 2],
    ["lowered", 2, 1],
  ])("an epoch %s warns on stderr and still passes, though the chainSeq went down", async (_label, before, after) => {
    await verifyPair(tenant(before, "9"), tenant(after, "0"));

    expect(printed()).toContain("PASS");
    expect(warned()).toContain(`WARN: epoch changed for tenantTag=${TAG}: prior=${before}, current=${after}`);
  });

  it("an unchanged epoch over an advancing chainSeq passes without a warning", async () => {
    await verifyPair(tenant(1, "9"), tenant(1, "10"));

    expect(printed()).toContain("PASS");
    expect(warned()).toBe("");
  });
});
