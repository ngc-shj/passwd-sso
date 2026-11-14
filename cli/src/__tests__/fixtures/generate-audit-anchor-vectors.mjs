#!/usr/bin/env node
/**
 * Generator of audit-anchor-vectors.json, the vectors the CLI verifier and the
 * server's anchor-manifest module are both held to.
 *
 *   node cli/src/__tests__/fixtures/generate-audit-anchor-vectors.mjs          # rewrite the file
 *   node cli/src/__tests__/fixtures/generate-audit-anchor-vectors.mjs --check  # exit 1 when it differs
 *
 * Uses node:crypto only, and neither implementation under test: the values are
 * an independent statement of the format. Ed25519 signatures are deterministic,
 * so the output is reproducible byte for byte.
 *
 * The seed is the low-entropy constant the tenant-tag golden vector already
 * uses (0x42 × 32). It signs nothing outside this file.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUTPUT = fileURLToPath(new URL("./audit-anchor-vectors.json", import.meta.url));

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX_LEN = 12;
const KID_PREFIX = "audit-anchor-";
const TYP = "passwd-sso.audit-anchor.v1";
const CHAIN_LOCATION_DOMAIN = "audit-anchor-chain-location-v1";

/** SHA-256 over the domain label, a null byte and the location, in hex. */
function chainLocation(location) {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from(CHAIN_LOCATION_DOMAIN), Buffer.from([0x00]), Buffer.from(location)]))
    .digest("hex");
}

function keyPair(seed) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(ED25519_SPKI_PREFIX_LEN);
  return { privateKey, publicKey, kid: `${KID_PREFIX}${publicKey.subarray(0, 8).toString("hex")}` };
}

function b64url(buf) {
  return buf.toString("base64url");
}

/** JCS for the value shapes a manifest holds: sorted keys, no whitespace. */
function jcs(value) {
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function jws(privateKey, header, payload, { zeroSignature = false } = {}) {
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(payload))}`;
  const signature = zeroSignature ? Buffer.alloc(64) : sign(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

function buildVectors() {
  const seed = Buffer.alloc(32, 0x42);
  const own = keyPair(seed);
  const other = keyPair(Buffer.alloc(32, 0x43));

  const manifest = {
    $schema: "https://passwd-sso.example/schemas/audit-anchor-manifest-v1.json",
    version: 1,
    issuer: "passwd-sso",
    deploymentId: "vector-deployment",
    anchoredAt: "2026-01-15T00:05:00.000Z",
    previousManifest: null,
    tenants: [
      {
        tenantTag: "6db2cb938b211a0b0824844113d78dd8aaafbeb608b6a2fc3903aa5114c03323",
        chainSeq: "5",
        prevHash: "ab".repeat(32),
        epoch: 1,
      },
    ],
  };
  const payload = jcs(manifest);
  // Format version 2: the same body, bound to the location it was published to.
  const locations = ["s3://example-bucket/audit-anchors", "s3://example-bucket", "github://example/anchors", "file:///var/lib/anchors"];
  const manifestV2 = {
    ...manifest,
    $schema: "https://passwd-sso.example/schemas/audit-anchor-manifest-v2.json",
    version: 2,
    chainLocation: chainLocation(locations[0]),
  };
  const manifestV2WithoutLocation = Object.fromEntries(
    Object.entries(manifestV2).filter(([field]) => field !== "chainLocation"),
  );
  const header = (kid) => ({ alg: "EdDSA", kid, typ: TYP });
  const publicKeyHex = own.publicKey.toString("hex");

  return {
    generator: "generate-audit-anchor-vectors.mjs",
    key: { seedHex: seed.toString("hex"), publicKeyHex, kid: own.kid },
    manifest,
    manifestV2,
    // The server derives each hash from its location; a verifier only compares them.
    chainLocations: locations.map((location) => ({ location, chainLocation: chainLocation(location) })),
    // Every JWS is checked under `key.publicKeyHex`. `expect` is "ok" or the
    // name of the error both implementations raise.
    jws: [
      { name: "valid manifest", jws: jws(own.privateKey, header(own.kid), payload), expect: "ok" },
      { name: "valid version 2 manifest", jws: jws(own.privateKey, header(own.kid), jcs(manifestV2)), expect: "ok" },
      {
        name: "version 2 without a chainLocation",
        jws: jws(own.privateKey, header(own.kid), jcs(manifestV2WithoutLocation)),
        expect: "ManifestSchemaValidationError",
      },
      {
        name: "version 2 with an upper-case chainLocation",
        jws: jws(
          own.privateKey,
          header(own.kid),
          jcs({ ...manifestV2, chainLocation: manifestV2.chainLocation.toUpperCase() }),
        ),
        expect: "ManifestSchemaValidationError",
      },
      {
        name: "version 2 with a 63-char chainLocation",
        jws: jws(own.privateKey, header(own.kid), jcs({ ...manifestV2, chainLocation: manifestV2.chainLocation.slice(1) })),
        expect: "ManifestSchemaValidationError",
      },
      {
        // The field is not part of version 1: the payload is not the canonical
        // form of the manifest it parses to.
        name: "version 1 carrying a chainLocation",
        jws: jws(own.privateKey, header(own.kid), jcs({ ...manifest, chainLocation: manifestV2.chainLocation })),
        expect: "InvalidSignatureError",
      },
      {
        name: "a version neither implementation knows",
        jws: jws(own.privateKey, header(own.kid), jcs({ ...manifestV2, version: 3 })),
        expect: "ManifestSchemaValidationError",
      },
      {
        name: "valid signature under a header naming another key",
        jws: jws(own.privateKey, header(other.kid), payload),
        expect: "KidMismatchError",
      },
      {
        name: "another key's kid and a bad signature: the kid is reported first",
        jws: jws(own.privateKey, header(other.kid), payload, { zeroSignature: true }),
        expect: "KidMismatchError",
      },
      {
        name: "own kid and a bad signature",
        jws: jws(own.privateKey, header(own.kid), payload, { zeroSignature: true }),
        expect: "InvalidSignatureError",
      },
      {
        // JSON.parse accepts these; neither is a header object.
        name: "header is JSON null",
        jws: jws(own.privateKey, null, payload),
        expect: "InvalidSignatureError",
      },
      {
        name: "header is a JSON string",
        jws: jws(own.privateKey, "EdDSA", payload),
        expect: "InvalidSignatureError",
      },
      {
        name: "malformed kid: upper-case hex",
        jws: jws(own.privateKey, header(own.kid.toUpperCase().replace("AUDIT-ANCHOR-", KID_PREFIX)), payload),
        expect: "InvalidKidError",
      },
      {
        name: "malformed kid: 8 hex chars",
        jws: jws(own.privateKey, header(own.kid.slice(0, KID_PREFIX.length + 8)), payload),
        expect: "InvalidKidError",
      },
      {
        name: "malformed kid: path separator",
        jws: jws(own.privateKey, header(`${KID_PREFIX}../../etc/passwd`), payload),
        expect: "InvalidKidError",
      },
      {
        // An unverified header's kid reaches the error message: both sides quote it.
        name: "malformed kid: control characters",
        jws: jws(own.privateKey, header(`${KID_PREFIX}\u001b[31mred\nline`), payload),
        expect: "InvalidKidError",
      },
      {
        name: "anchoredAt not in the toISOString form",
        jws: jws(own.privateKey, header(own.kid), jcs({ ...manifest, anchoredAt: "2026-01-15T00:05:00Z" })),
        expect: "ManifestSchemaValidationError",
      },
      {
        // toISOString round-trips this; its date part is not YYYY-MM-DD.
        name: "anchoredAt with an expanded year",
        jws: jws(own.privateKey, header(own.kid), jcs({ ...manifest, anchoredAt: "+010000-01-01T00:00:00.000Z" })),
        expect: "ManifestSchemaValidationError",
      },
    ],
    publicKeyTexts: [
      { name: "64 hex chars", text: publicKeyHex, valid: true },
      { name: "64 hex chars and a trailing newline", text: `${publicKeyHex}\n`, valid: true },
      { name: "63 hex chars", text: publicKeyHex.slice(0, 63), valid: false },
      { name: "65 hex chars", text: `${publicKeyHex}0`, valid: false },
      { name: "upper-case hex", text: publicKeyHex.toUpperCase(), valid: false },
      { name: "64 chars, one not hex", text: `${publicKeyHex.slice(0, 63)}g`, valid: false },
      { name: "64 hex chars, then a non-hex tail", text: `${publicKeyHex}zz`, valid: false },
    ],
    // Base URLs for the manifest and the public-key archive.
    urls: [
      { name: "https", url: "https://anchors.example.com/", allowed: true },
      { name: "http to localhost", url: "http://localhost:8080/", allowed: true },
      { name: "http to 127.0.0.1", url: "http://127.0.0.1:8080/", allowed: true },
      { name: "http to [::1]", url: "http://[::1]:8080/", allowed: true },
      { name: "http to another host", url: "http://anchors.example.com/", allowed: false },
      { name: "upper-case scheme", url: "HTTPS://anchors.example.com/", allowed: false },
      { name: "loopback as a subdomain label", url: "http://127.0.0.1.example.com/", allowed: false },
      { name: "loopback as userinfo", url: "http://127.0.0.1@example.com/", allowed: false },
      { name: "another scheme", url: "ftp://localhost/", allowed: false },
    ],
  };
}

const rendered = `${JSON.stringify(buildVectors(), null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(OUTPUT, "utf8") !== rendered) {
    console.error(`${OUTPUT} differs from the generator's output; rerun the generator`);
    process.exit(1);
  }
} else {
  writeFileSync(OUTPUT, rendered);
}
