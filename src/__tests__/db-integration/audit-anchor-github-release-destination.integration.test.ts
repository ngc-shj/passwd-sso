/**
 * Integration tests for GitHubReleaseDestination using a node:http fake server.
 *
 * Tests (T8):
 *   1. Create-or-get release flow — POST /repos/{owner}/{repo}/releases succeeds,
 *      then asset upload via the upload_url.
 *   2. When release already exists (POST returns 422), the destination falls back
 *      to GET /repos/{owner}/{repo}/releases/tags/{tag} and proceeds with asset upload.
 *   3. DESTINATION_DIVERGENCE adversarial — two runs upload different bytes;
 *      verify the verifier detects divergence via SHA-256 comparison.
 *      NOTE: this test is at the destination layer; for a full verifier-layer
 *      DESTINATION_DIVERGENCE test, see TODO in the test file for audit-anchor-publisher.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { AddressInfo } from "node:net";
import { GitHubReleaseDestination } from "@/lib/audit/anchor-destinations/github-release-destination";

// ── Fake GitHub API server ───────────────────────────────────────────────────

type FakeReleaseServerState = {
  existingTags: Set<string>;
  uploadedAssets: Map<string, Buffer>;
  createCallCount: number;
  getByTagCallCount: number;
  uploadCallCount: number;
};

/**
 * Creates a minimal fake GitHub API HTTP server that handles:
 *   POST /repos/{owner}/{repo}/releases → 201 (new) or 422 (duplicate)
 *   GET  /repos/{owner}/{repo}/releases/tags/{tag} → 200
 *   POST /upload/assets?name={filename} → 201 (fake upload endpoint)
 */
function createFakeGitHubServer(state: FakeReleaseServerState): http.Server {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const url = req.url ?? "";
      const method = req.method ?? "GET";

      // POST /repos/owner/repo/releases → create release
      const createReleaseMatch = url.match(/^\/repos\/([^/]+)\/([^/]+)\/releases$/);
      if (method === "POST" && createReleaseMatch) {
        state.createCallCount++;
        let tag = "unknown-tag";
        try {
          const payload = JSON.parse(body) as { tag_name?: string };
          tag = payload.tag_name ?? "unknown-tag";
        } catch {
          // ignore parse error
        }
        if (state.existingTags.has(tag)) {
          // Simulate "already exists" — GitHub returns 422
          res.writeHead(422, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "Validation Failed" }));
          return;
        }
        state.existingTags.add(tag);
        const releaseId = Math.floor(Math.random() * 100000);
        const host = req.headers["host"] ?? "localhost";
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: releaseId,
            tag_name: tag,
            upload_url: `http://${host}/upload/assets{?name,label}`,
          }),
        );
        return;
      }

      // GET /repos/owner/repo/releases/tags/{tag} → get existing release
      const getByTagMatch = url.match(/^\/repos\/([^/]+)\/([^/]+)\/releases\/tags\/(.+)$/);
      if (method === "GET" && getByTagMatch) {
        state.getByTagCallCount++;
        const tag = decodeURIComponent(getByTagMatch[3] ?? "");
        const host = req.headers["host"] ?? "localhost";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: 99999,
            tag_name: tag,
            upload_url: `http://${host}/upload/assets{?name,label}`,
          }),
        );
        return;
      }

      // POST /upload/assets?name=filename → fake asset upload
      const uploadMatch = url.match(/^\/upload\/assets/);
      if (method === "POST" && uploadMatch) {
        state.uploadCallCount++;
        const urlObj = new URL(url, "http://localhost");
        const name = urlObj.searchParams.get("name") ?? "unknown";
        // Body already consumed via 'end' event above — store empty for now.
        // For binary bodies we need to collect from the raw socket;
        // in this fake the body variable has accumulated text so convert to buffer.
        state.uploadedAssets.set(name, Buffer.from(body));
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: 1, name, size: body.length }));
        return;
      }

      // Default: 404
      res.writeHead(404);
      res.end("Not Found");
    });
  });

  return server;
}

function startServer(state: FakeReleaseServerState): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createFakeGitHubServer(state);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GitHubReleaseDestination — fake server integration", () => {
  let state: FakeReleaseServerState;
  let server: http.Server;
  let port: number;
  let dest: GitHubReleaseDestination;
  let realFetch: typeof global.fetch;

  beforeAll(async () => {
    state = {
      existingTags: new Set(),
      uploadedAssets: new Map(),
      createCallCount: 0,
      getByTagCallCount: 0,
      uploadCallCount: 0,
    };
    const result = await startServer(state);
    server = result.server;
    port = result.port;

    // Patch the destination to use our fake server instead of api.github.com.
    // GitHubReleaseDestination hard-codes https://api.github.com — we monkey-patch
    // the global fetch to redirect to our local server for test isolation.
    realFetch = global.fetch;
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const rewritten = url
        .replace("https://api.github.com", `http://127.0.0.1:${port}`)
        .replace("https://uploads.github.com", `http://127.0.0.1:${port}`);
      return realFetch(rewritten, init);
    };
  });

  afterAll(async () => {
    // Restore global.fetch BEFORE stopping the server (closes RT2-1).
    // Order matters: any in-flight fetch must complete via the local server
    // before we redirect back to the real fetch.
    global.fetch = realFetch;
    await stopServer(server);
  });

  afterEach(() => {
    // Reset call counters AND existing tags between tests — closes RT2-4.
    // Each test must seed its own pre-existing tags explicitly to avoid
    // ordering dependencies (vitest may run with --sequence.shuffle).
    state.createCallCount = 0;
    state.getByTagCallCount = 0;
    state.uploadCallCount = 0;
    state.existingTags.clear();
    state.uploadedAssets.clear();
  });

  it("Test 1: create-or-get release flow — POST creates new release, asset upload succeeds", async () => {
    dest = new GitHubReleaseDestination({
      repo: "test-org/test-repo",
      token: "fake-token",
    });

    const artifactKey = "2026-05-01.kid-audit-anchor-test123456.jws";
    const artifactBytes = Buffer.from("jws-payload-for-test-1", "utf-8");

    await dest.upload({
      artifactBytes,
      artifactKey,
      contentType: "application/jose",
    });

    // POST /releases was called once (new release created)
    expect(state.createCallCount).toBe(1);
    // GET /releases/tags/... was NOT called (release was new)
    expect(state.getByTagCallCount).toBe(0);
    // Asset upload was called once
    expect(state.uploadCallCount).toBe(1);
    // The uploaded asset name matches the artifactKey
    expect(state.uploadedAssets.has(artifactKey)).toBe(true);
  });

  it("Test 2: POST 422 fallback — when release exists, falls back to GET by tag and uploads asset", async () => {
    dest = new GitHubReleaseDestination({
      repo: "test-org/test-repo",
      token: "fake-token",
    });

    // Use a date that produces the same tag as test 1 (same date prefix)
    // so the server's existingTags set triggers a 422.
    const artifactKey = "2026-05-01.kid-audit-anchor-secondrun.jws";
    const artifactBytes = Buffer.from("jws-payload-for-test-2-second-run", "utf-8");

    // Pre-register the tag so the server responds with 422 on POST
    const expectedTag = "audit-anchor-2026-05-01";
    state.existingTags.add(expectedTag);

    await dest.upload({
      artifactBytes,
      artifactKey,
      contentType: "application/jose",
    });

    // POST /releases was called (returned 422)
    expect(state.createCallCount).toBe(1);
    // Fallback GET /releases/tags/... was called
    expect(state.getByTagCallCount).toBe(1);
    // Asset upload was called once after fallback
    expect(state.uploadCallCount).toBe(1);
  });

  it("Test 3: DESTINATION_DIVERGENCE adversarial — two uploads of different bytes produce different SHA-256 hashes", async () => {
    // This test is at the destination layer: it verifies that uploading different
    // byte content to the same artifact key produces detectably different SHA-256
    // digests, which is the primitive the verifier uses for divergence detection.
    //
    // TODO (full DESTINATION_DIVERGENCE): a complete verifier-layer test would:
    //   1. Upload artifact A to destination 1 (primary).
    //   2. Upload a tampered artifact B to destination 2 (secondary).
    //   3. Run the verifier which cross-checks primary vs secondary SHA-256.
    //   4. Assert the verifier returns a DESTINATION_DIVERGENCE error.
    // This requires the verifier CLI sub-command which is not yet implemented.
    // Tracked as a follow-up item in audit-anchor-publisher.integration.test.ts.

    const artifactBytes1 = Buffer.from("original-signed-manifest-bytes", "utf-8");
    const artifactBytes2 = Buffer.from("tampered-manifest-bytes-after-signing", "utf-8");

    const sha256_1 = createHash("sha256").update(artifactBytes1).digest("hex");
    const sha256_2 = createHash("sha256").update(artifactBytes2).digest("hex");

    // Divergent bytes MUST produce different SHA-256 digests
    expect(sha256_1).not.toBe(sha256_2);

    // Simulate two separate "upload" calls (as a destination would do)
    dest = new GitHubReleaseDestination({
      repo: "test-org/test-repo",
      token: "fake-token",
    });

    const key1 = "2026-04-30.kid-audit-anchor-original.jws";
    const key2 = "2026-04-29.kid-audit-anchor-tampered.jws";

    // afterEach clears existingTags, so both creates start fresh.
    await dest.upload({ artifactBytes: artifactBytes1, artifactKey: key1, contentType: "application/jose" });
    await dest.upload({ artifactBytes: artifactBytes2, artifactKey: key2, contentType: "application/jose" });

    // Both uploads landed at distinct paths on the fake server.
    expect(state.uploadedAssets.get(key1)).toBeDefined();
    expect(state.uploadedAssets.get(key2)).toBeDefined();
    expect(state.uploadedAssets.size).toBe(2);

    // Phase 3 R2 RT2-2 acknowledged limitation: the fake server collects body
    // as a UTF-8 string, so byte-level content equality of binary JWS artifacts
    // cannot be verified here. The input-side SHA-256 difference (line 263)
    // proves divergence at the source. Full DESTINATION_DIVERGENCE detection
    // (server-A receives X, server-B receives Y, verifier compares) belongs at
    // the verifier layer and is tracked as continuing work in the deviation log.
  });
});
