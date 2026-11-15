/**
 * audit-verify's two fetches — the manifest and `<kid>.pub` from the archive —
 * against a real local listener: redirects are refused, the wait is bounded,
 * and a body is read no further than the size bound. A mocked fetch would only
 * restate what undici does with a redirect or an endless body.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIT_ANCHOR_ARTIFACT_MAX_BYTES } from "../../constants/audit-anchor.js";
import {
  AUDIT_VERIFY_FETCH_TIMEOUT_MS,
  ManifestFetchError,
  PublicKeyFetchError,
  ResponseTooLargeError,
  auditVerifyCommand,
} from "../../commands/audit-verify.js";

type Vectors = {
  key: { publicKeyHex: string; kid: string };
  jws: Array<{ jws: string; expect: string }>;
};
const VECTORS = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/audit-anchor-vectors.json", import.meta.url)), "utf8"),
) as Vectors;
const VALID_JWS = VECTORS.jws.find((v) => v.expect === "ok")!.jws;
const PUB = `${VECTORS.key.kid}.pub`;
// The form the key scripts archive: 64 hex chars and a newline.
const PUBLIC_KEY_TEXT = `${VECTORS.key.publicKeyHex}\n`;

const CHUNK = Buffer.alloc(1024 * 1024, 0x61);
const ENDLESS_BYTES = 3 * AUDIT_ANCHOR_ARTIFACT_MAX_BYTES;

let server: Server;
let origin: string;
let hits: string[];
/** Bytes the endless route wrote before the client went away. */
let endlessWritten: number;
let endlessClosedEarly: Promise<boolean>;

function ok(res: ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    hits.push(path);
    if (path === "/ok/manifest.jws" || path === "/target/manifest.jws") return ok(res, VALID_JWS);
    if (path === `/ok/keys/${PUB}` || path === `/target/keys/${PUB}`) return ok(res, PUBLIC_KEY_TEXT);
    if (path === "/redirect/manifest.jws") {
      res.writeHead(302, { Location: `${origin}/target/manifest.jws` });
      return res.end();
    }
    if (path === `/redirect/keys/${PUB}`) {
      res.writeHead(302, { Location: `${origin}/target/keys/${PUB}` });
      return res.end();
    }
    if (path === "/declared-large/manifest.jws") {
      // The length alone is past the bound; the body never comes.
      res.writeHead(200, { "Content-Length": AUDIT_ANCHOR_ARTIFACT_MAX_BYTES + 1 });
      return res.write("x");
    }
    if (path === "/at-bound/manifest.jws") {
      res.writeHead(200, { "Content-Length": AUDIT_ANCHOR_ARTIFACT_MAX_BYTES });
      return res.end(Buffer.alloc(AUDIT_ANCHOR_ARTIFACT_MAX_BYTES, 0x61));
    }
    if (path === "/endless/manifest.jws") {
      // No Content-Length: only counting the body can stop this one.
      res.writeHead(200);
      endlessClosedEarly = new Promise((resolve) => res.on("close", () => resolve(endlessWritten < ENDLESS_BYTES)));
      const pump = (): void => {
        while (endlessWritten < ENDLESS_BYTES && !res.destroyed) {
          endlessWritten += CHUNK.length;
          if (!res.write(CHUNK)) return void res.once("drain", pump);
        }
        if (!res.destroyed) res.end();
      };
      return pump();
    }
    if (path === "/hang/manifest.jws") return; // never answered
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

let tmpDir: string;
let stdout: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  hits = [];
  endlessWritten = 0;
  tmpDir = mkdtempSync(join(tmpdir(), "audit-verify-fetch-"));
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubEnv("AUDIT_ANCHOR_PUBLIC_KEY_ARCHIVE_URL", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(tmpDir, { recursive: true, force: true });
});

function keyFile(): string {
  const path = join(tmpDir, "key.pub");
  writeFileSync(path, PUBLIC_KEY_TEXT);
  return path;
}

function manifestFile(): string {
  const path = join(tmpDir, "m.jws");
  writeFileSync(path, VALID_JWS);
  return path;
}

function passed(): boolean {
  return stdout.mock.calls.some((c: unknown[]) => String(c[0]).includes("PASS"));
}

describe("audit-verify — a redirected fetch", () => {
  it("refuses a redirected manifest and never requests the redirect target", async () => {
    await expect(
      auditVerifyCommand({ manifest: `${origin}/redirect/manifest.jws`, publicKey: keyFile() }),
    ).rejects.toMatchObject({ name: ManifestFetchError.name, status: 302 });

    expect(hits).toEqual(["/redirect/manifest.jws"]);
    expect(passed()).toBe(false);
  });

  it("refuses a redirected public key and never requests the redirect target", async () => {
    await expect(
      auditVerifyCommand({ manifest: manifestFile(), archiveUrl: `${origin}/redirect/keys` }),
    ).rejects.toMatchObject({ name: PublicKeyFetchError.name, status: 302 });

    expect(hits).toEqual([`/redirect/keys/${PUB}`]);
    expect(passed()).toBe(false);
  });

  it("verifies when the same listener answers 200 for the manifest and the 65-byte public key", async () => {
    await auditVerifyCommand({ manifest: `${origin}/ok/manifest.jws`, archiveUrl: `${origin}/ok/keys` });

    expect(hits).toEqual(["/ok/manifest.jws", `/ok/keys/${PUB}`]);
    expect(passed()).toBe(true);
  });
});

describe("audit-verify — a fetch that is too large or too slow", () => {
  it("refuses a Content-Length past the bound without waiting for the body", async () => {
    await expect(
      auditVerifyCommand({ manifest: `${origin}/declared-large/manifest.jws`, publicKey: keyFile() }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("stops reading a body with no Content-Length once it is past the bound", async () => {
    await expect(
      auditVerifyCommand({ manifest: `${origin}/endless/manifest.jws`, publicKey: keyFile() }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);

    // The connection ended with most of the body unsent.
    expect(await endlessClosedEarly).toBe(true);
  });

  it("reads a body exactly at the bound whole: the refusal that follows is about its content", async () => {
    await expect(
      auditVerifyCommand({ manifest: `${origin}/at-bound/manifest.jws`, publicKey: keyFile() }),
    ).rejects.toMatchObject({ name: "InvalidSignatureError" });
  });

  it("gives up on a server that never answers, at the fetch timeout", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(50));

    await expect(
      auditVerifyCommand({ manifest: `${origin}/hang/manifest.jws`, publicKey: keyFile() }),
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(timeout).toHaveBeenCalledWith(AUDIT_VERIFY_FETCH_TIMEOUT_MS);
  });
});
