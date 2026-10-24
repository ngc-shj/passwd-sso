#!/usr/bin/env node
/**
 * C1 probe: a SAML sign-in cannot be completed through one Jackson connection's
 * OIDC client with another connection's IdP (issue #742, plan
 * docs/archive/review/sso-claim-connection-binding-plan.md, "Measured premise").
 *
 * The app-side control is "no PKCE, each provider exchanges with its own
 * connection's credentials". Whether that control holds is decided by Jackson's
 * token endpoint, not by this repo, so it is measured against the Jackson images
 * the repo references rather than asserted from reading Jackson's source:
 *
 *   attack (IdP A's signed response must first produce a code, then 401 whose
 *   body names the refusing check):
 *     M8b  client_id=B&idp_hint=A, B's credentials, no PKCE
 *     M5a  client_id rewritten B -> A, B's credentials, no PKCE
 *     M9   attacker-added code_challenge, the app sends no code_verifier
 *   allow (200, id_token aud = the exchanging client):
 *     M8a  A legit, M8c  B legit
 *   positive controls (200 — prove the probe can see the hole it guards):
 *     M1   PKCE with the correct verifier, B's credentials
 *     M9   the same code as above, with the attacker's verifier
 *
 * Two modes, both run inside a container of a pinned Jackson image with
 * `--entrypoint node` (the image carries @boxyhq/saml20 and node-forge, which
 * sign the IdP responses and mint the IdP certificates; nothing is committed).
 * That driver image needs those as standalone modules — 1.52.2 has them,
 * 1.42.0 bundles them into its Next.js chunks — and plays only the IdP and the
 * app, so it may differ from the server image under test:
 *
 *   node jackson-connection-binding.mjs env
 *     Prints a docker --env-file for the Jackson server under test: a fresh API
 *     key, NEXTAUTH_SECRET and OIDC signing keypair. Run once per probe run.
 *
 *   node jackson-connection-binding.mjs run
 *     Env: JACKSON_URL (base URL as the server's EXTERNAL_URL names it),
 *     JACKSON_API_KEYS (from the env file), EXPECTED_JACKSON_VERSION,
 *     REPO_ROOT (holding node_modules/ and package-lock.json, mounted read-only).
 *     Drives the flows over HTTP and exchanges codes through the repo's own
 *     oauth4webapi (the copy @auth/core resolves) with ClientSecretBasic — the
 *     request Auth.js v5 sends. Exits 1 on any mismatch, 2 when it cannot run.
 *
 * Jackson runs with DB_ENGINE=mem, so the connections this creates die with the
 * container; removing the containers and network is the caller's job.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import zlib from "node:zlib";

const JACKSON_APP_DIR = "/app/";
const REDIRECT = "http://localhost:9999/cb";
const SAML_AUDIENCE = "https://saml.boxyhq.com";
const PRODUCT = "passwd-sso";
const BODY_CLIENT_CHECK = /Invalid client_id or client_secret/;
// Jackson 1.52.2 refuses an attacker-added challenge with no verifier at the PKCE
// check, 1.42.0 at the client check (measured); either is the refusal under test.
const BODY_PKCE_OR_CLIENT_CHECK = /Invalid code_verifier|Invalid client_id or client_secret/;

const imageRequire = createRequire(JACKSON_APP_DIR);
const form = (o) => new URLSearchParams(o).toString();
const b64url = (b) => Buffer.from(b).toString("base64url");
const s256 = (v) => b64url(crypto.createHash("sha256").update(v).digest());
const random = () => b64url(crypto.randomBytes(16));

class SetupError extends Error {}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new SetupError(`${name} is required`);
  return value;
}

// ─── env mode ──────────────────────────────────────────────────────────────

function printServerEnv() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = (k, type) => k.export({ type, format: "pem" });
  const lines = [
    `JACKSON_API_KEYS=${random()}`,
    `NEXTAUTH_SECRET=${random()}`,
    // Jackson reads both as base64 of the PEM.
    `OPENID_RSA_PRIVATE_KEY=${Buffer.from(pem(privateKey, "pkcs8")).toString("base64")}`,
    `OPENID_RSA_PUBLIC_KEY=${Buffer.from(pem(publicKey, "spki")).toString("base64")}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ─── run mode ──────────────────────────────────────────────────────────────

/** The oauth4webapi copy @auth/core resolves, asserted equal to the lockfile's. */
async function loadRepoOauth4webapi(repoRoot) {
  const authCorePkg = join(repoRoot, "node_modules/@auth/core/package.json");
  const fromAuthCore = createRequire(authCorePkg);
  const entry = fromAuthCore.resolve("oauth4webapi");
  const pkgPath = fromAuthCore.resolve("oauth4webapi/package.json");
  const installed = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  const lockKey = relative(repoRoot, dirname(pkgPath));
  const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
  const locked = lock.packages?.[lockKey]?.version;
  if (!locked || installed !== locked) {
    throw new SetupError(`oauth4webapi at ${lockKey} is ${installed}, package-lock.json pins ${locked ?? "nothing"}`);
  }
  return { o: await import(pathToFileURL(entry).href), version: installed, lockKey };
}

function makeIdp(name) {
  const forge = imageRequire("node-forge");
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs1", format: "pem" });
  const forgeKey = forge.pki.privateKeyFromPem(keyPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(forgeKey.n, forgeKey.e);
  cert.serialNumber = `01${crypto.randomBytes(8).toString("hex")}`;
  const now = Date.now();
  cert.validity.notBefore = new Date(now - 60 * 60 * 1000);
  cert.validity.notAfter = new Date(now + 24 * 60 * 60 * 1000);
  const subject = [{ name: "commonName", value: `idp-${name}.example` }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.sign(forgeKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  const certB64 = certPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const entityId = `https://idp-${name}.example/metadata`;
  const metadata =
    `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">` +
    `<md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
    `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data>` +
    `<ds:X509Certificate>${certB64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
    `<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>` +
    `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp-${name}.example/sso"/>` +
    `</md:IDPSSODescriptor></md:EntityDescriptor>`;
  return { entityId, key: keyPem, cert: certPem, metadata };
}

async function waitForJackson(base) {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return (await r.json()).version;
    } catch {
      // Not listening yet; retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new SetupError(`Jackson at ${base} did not answer /api/health within 180s`);
}

async function createConnection(base, apiKey, name, idp) {
  const r = await fetch(`${base}/api/v1/sso`, {
    method: "POST",
    headers: { Authorization: `Api-Key ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      rawMetadata: idp.metadata,
      defaultRedirectUrl: REDIRECT,
      redirectUrl: JSON.stringify([REDIRECT]),
      tenant: `tenant${name}`,
      product: PRODUCT,
      name: `conn${name}`,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (r.status !== 200 || !body.clientID || !body.clientSecret) {
    throw new SetupError(`creating connection ${name} returned ${r.status}`);
  }
  return { client_id: body.clientID, client_secret: body.clientSecret };
}

/** Returns the SAMLRequest's ID/ACS and RelayState, or a reason it has none. */
async function authorize(base, params) {
  const r = await fetch(`${base}/api/oauth/authorize?${form(params)}`, { redirect: "manual" });
  const loc = r.headers.get("location");
  if (!loc) return { error: `authorize ${r.status} without a redirect` };
  const u = new URL(loc, base);
  const samlRequest = u.searchParams.get("SAMLRequest");
  if (!samlRequest) return { error: `authorize redirected without a SAMLRequest: ${u.searchParams.get("error_description") ?? u.pathname}` };
  const xml = zlib.inflateRawSync(Buffer.from(samlRequest, "base64")).toString();
  return {
    requestId: xml.match(/ ID="([^"]+)"/)?.[1],
    acs: xml.match(/AssertionConsumerServiceURL="([^"]+)"/)?.[1],
    relayState: u.searchParams.get("RelayState"),
  };
}

/** Posts a response signed by `idp` to Jackson's ACS; returns the callback URL carrying the code. */
async function postSignedResponse(base, idp, request, email) {
  const saml = imageRequire("@boxyhq/saml20").default;
  const xml = await saml.createSAMLResponse({
    audience: SAML_AUDIENCE,
    issuer: idp.entityId,
    acsUrl: request.acs,
    claims: { email, raw: { email } },
    requestId: request.requestId,
    privateKey: idp.key,
    publicKey: idp.cert,
  });
  const r = await fetch(`${base}/api/oauth/saml`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ SAMLResponse: Buffer.from(xml).toString("base64"), RelayState: request.relayState }),
  });
  const loc = r.headers.get("location");
  const url = loc ? new URL(loc, base) : null;
  return url?.searchParams.get("code") ? url : null;
}

/** The token request exactly as Auth.js v5 sends it: oauth4webapi + ClientSecretBasic. */
async function exchange(ctx, creds, callbackUrl, state, nonce, codeVerifier) {
  const { o, as } = ctx;
  const client = { client_id: creds.client_id };
  const params = o.validateAuthResponse(as, client, callbackUrl, state);
  let sentVerifier = false;
  const response = await o.authorizationCodeGrantRequest(
    as, client, o.ClientSecretBasic(creds.client_secret), params, REDIRECT, codeVerifier ?? o.nopkce,
    {
      [o.allowInsecureRequests]: true,
      [o.customFetch]: (url, init) => {
        sentVerifier = new URLSearchParams(String(init.body)).has("code_verifier");
        return fetch(url, init);
      },
    },
  );
  const status = response.status;
  const body = status === 200 ? "" : (await response.clone().text()).slice(0, 200);
  let aud = null;
  let email = null;
  let processing = "ok";
  if (status === 200) {
    try {
      const result = await o.processAuthorizationCodeResponse(as, client, response, { expectedNonce: nonce, requireIdToken: true });
      const claims = o.getValidatedIdTokenClaims(result);
      aud = Array.isArray(claims.aud) ? claims.aud.join(",") : claims.aud;
      email = claims.email;
    } catch (e) {
      processing = `${e.constructor.name}: ${e.message}`;
    }
  }
  return { status, body, aud, email, processing, sentVerifier };
}

const results = [];

function record(label, expected, observed, pass) {
  results.push({ label, expected, observed, pass });
}

const short = (id) => (id ? `${id.slice(0, 8)}…` : String(id));

function describeExchange(r) {
  if (r.status !== 200) return `${r.status} "${r.body}"`;
  if (r.processing !== "ok") return `200 but ${r.processing}`;
  return `200 aud=${short(r.aud)} email=${r.email}`;
}

/**
 * One authorize → IdP → ACS → token round. Each step of `steps` exchanges the
 * same code in order (Jackson consumes a code only on success).
 */
async function runCase(ctx, { label, authz, idp, email, steps }) {
  const state = random();
  const nonce = random();
  const params = { response_type: "code", redirect_uri: REDIRECT, scope: "openid email profile", state, nonce, ...authz };
  const request = await authorize(ctx.base, params);
  if (request.error || !request.requestId || !request.acs) {
    record(label, "authorize issues a SAMLRequest", request.error ?? "SAMLRequest without ID/ACS", false);
    return;
  }
  const callback = await postSignedResponse(ctx.base, ctx.idps[idp], request, email);
  record(`${label} | precondition`, `IdP ${idp}'s signed response yields a code`, callback ? "code issued" : "no code", !!callback);
  if (!callback) return;
  for (const step of steps) {
    const r = await exchange(ctx, step.creds, callback, state, nonce, step.codeVerifier);
    const wireOk = r.sentVerifier === (step.codeVerifier !== undefined);
    let pass;
    if (step.expect === 401) {
      pass = r.status === 401 && step.body.test(r.body);
    } else {
      pass = r.status === 200 && r.processing === "ok" && r.aud === step.creds.client_id && r.email === email;
    }
    const expected = step.expect === 401 ? `401 ${step.body}` : `200 aud=${short(step.creds.client_id)} email=${email}`;
    const observed = wireOk ? describeExchange(r) : `code_verifier on the wire: ${r.sentVerifier}`;
    record(`${label} | ${step.note}`, expected, observed, pass && wireOk);
  }
}

function printTable(header) {
  const rows = results.map((r) => [r.pass ? "PASS" : "FAIL", r.label, r.expected, r.observed]);
  const widths = [4, ...[1, 2].map((i) => Math.max(...rows.map((row) => row[i].length)))];
  console.log(header);
  for (const row of rows) {
    console.log(row.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell)).join("  "));
  }
}

async function run() {
  const base = requireEnv("JACKSON_URL").replace(/\/$/, "");
  const apiKey = requireEnv("JACKSON_API_KEYS").split(",")[0];
  const expectedVersion = requireEnv("EXPECTED_JACKSON_VERSION");
  const repoRoot = requireEnv("REPO_ROOT");

  const { o, version: o4wVersion, lockKey } = await loadRepoOauth4webapi(repoRoot);
  const jacksonVersion = await waitForJackson(base);
  if (jacksonVersion !== expectedVersion) {
    throw new SetupError(`Jackson reports ${jacksonVersion}, expected ${expectedVersion} (image digest and version disagree)`);
  }
  const discovery = await fetch(`${base}/.well-known/openid-configuration`);
  if (!discovery.ok) throw new SetupError(`discovery returned ${discovery.status}`);
  const as = await discovery.json();

  const idps = { A: makeIdp("a"), B: makeIdp("b") };
  const A = await createConnection(base, apiKey, "A", idps.A);
  const B = await createConnection(base, apiKey, "B", idps.B);
  const ctx = { base, o, as, idps };
  const verifier = random() + random();
  const decoy = random() + random();

  await runCase(ctx, {
    label: "M8a A legit",
    authz: { client_id: A.client_id }, idp: "A", email: "alice@a.example",
    steps: [{ note: "Basic A", creds: A, expect: 200 }],
  });
  await runCase(ctx, {
    label: "M8c B legit",
    authz: { client_id: B.client_id }, idp: "B", email: "bob@b.example",
    steps: [{ note: "Basic B", creds: B, expect: 200 }],
  });
  await runCase(ctx, {
    label: "M8b B&idp_hint=A",
    authz: { client_id: B.client_id, idp_hint: A.client_id }, idp: "A", email: "attacker@a.example",
    steps: [{ note: "Basic B", creds: B, expect: 401, body: BODY_CLIENT_CHECK }],
  });
  await runCase(ctx, {
    label: "M5a client_id B->A",
    authz: { client_id: A.client_id }, idp: "A", email: "attacker@a.example",
    steps: [{ note: "Basic B", creds: B, expect: 401, body: BODY_CLIENT_CHECK }],
  });
  await runCase(ctx, {
    label: "M9  B&idp_hint=A+challenge",
    authz: { client_id: B.client_id, idp_hint: A.client_id, code_challenge: s256(decoy), code_challenge_method: "S256" },
    idp: "A", email: "attacker@a.example",
    steps: [
      { note: "Basic B, no verifier", creds: B, expect: 401, body: BODY_PKCE_OR_CLIENT_CHECK },
      { note: "control: Basic B + attacker verifier", creds: B, codeVerifier: decoy, expect: 200 },
    ],
  });
  await runCase(ctx, {
    label: "M1  B&idp_hint=A+PKCE",
    authz: { client_id: B.client_id, idp_hint: A.client_id, code_challenge: s256(verifier), code_challenge_method: "S256" },
    idp: "A", email: "attacker@a.example",
    steps: [{ note: "control: Basic B + verifier", creds: B, codeVerifier: verifier, expect: 200 }],
  });

  printTable(`jackson ${jacksonVersion} | oauth4webapi ${o4wVersion} (${lockKey}) | ClientSecretBasic`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(failed === 0 ? `OK: ${results.length} checks` : `FAIL: ${failed} of ${results.length} checks`);
  return failed === 0 ? 0 : 1;
}

const mode = process.argv[2];
try {
  if (mode === "env") {
    printServerEnv();
  } else if (mode === "run") {
    process.exitCode = await run();
  } else {
    throw new SetupError("usage: jackson-connection-binding.mjs env|run");
  }
} catch (e) {
  if (results.length > 0) printTable("partial results");
  console.error(`jackson-connection-binding: ${e instanceof SetupError ? "SETUP" : "ERROR"}: ${e.message}`);
  process.exitCode = 2;
}
