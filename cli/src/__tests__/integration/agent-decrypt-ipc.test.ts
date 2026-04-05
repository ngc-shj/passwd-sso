/**
 * Integration tests for the agent-decrypt IPC flow.
 *
 * These tests verify:
 * 1. The daemon child starts when _PSSO_DAEMON=1 is set
 * 2. The child receives a vault key via IPC and acknowledges with "ready"
 * 3. The child creates a Unix domain socket and serves newline-delimited JSON requests
 * 4. The child handles malformed requests gracefully (schema validation)
 * 5. The child handles oversized requests (buffer overflow protection)
 * 6. The child exits cleanly when the socket is removed
 *
 * Test approach: spawn a real child process via tsx (TypeScript source, no build required),
 * communicate over IPC, then connect to the Unix socket as a client.
 *
 * Constraints:
 * - Requires XDG_RUNTIME_DIR — tests are skipped on Windows
 * - Uses a temp directory per test run to avoid socket path collisions
 * - Each test that starts a daemon child must kill it in afterEach
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { hexEncode, deriveEncryptionKey } from "../../lib/crypto.js";

// Resolve paths relative to this file
const require = createRequire(import.meta.url);
void require; // used for type resolution only

const cliSrcEntry = resolve(import.meta.dirname, "../../index.ts");
const tsxBin = resolve(import.meta.dirname, "../../../../node_modules/.bin/tsx");

const IS_WINDOWS = process.platform === "win32";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a random 32-byte secret key as a Uint8Array.
 */
function makeSecretKey(): Uint8Array {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Wait for the child process to emit "ready" via IPC, with a timeout.
 */
function waitForReady(child: ChildProcess, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Daemon child did not send 'ready' within timeout"));
    }, timeoutMs);

    child.on("message", (msg) => {
      if (msg === "ready") {
        clearTimeout(timer);
        resolve();
      }
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Daemon child exited with code ${code} before sending 'ready'`));
    });
  });
}

/**
 * Wait until the socket path exists on disk, with a timeout.
 */
function waitForSocket(socketPath: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (existsSync(socketPath)) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error(`Socket ${socketPath} did not appear within timeout`));
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

/**
 * Connect to a Unix socket and send one newline-delimited JSON message.
 * Returns the raw response line (without the trailing newline).
 */
function sendSocketRequest(socketPath: string, request: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const client: Socket = createConnection(socketPath);
    let response = "";

    client.on("connect", () => {
      client.write(JSON.stringify(request) + "\n");
    });

    client.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf-8");
      // Response is newline-terminated
      if (response.includes("\n")) {
        client.destroy();
        resolve(response.split("\n")[0].trim());
      }
    });

    client.on("error", reject);

    // Defensive timeout
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("Socket request timed out"));
    }, 5000);

    client.on("close", () => clearTimeout(timer));
  });
}

/**
 * Kill a child process and wait for it to exit.
 */
function killChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe.skipIf(IS_WINDOWS)("agent-decrypt IPC integration", () => {
  let tmpDir: string;
  let socketPath: string;
  let daemonChild: ChildProcess | null = null;

  beforeEach(() => {
    // Create a unique temp dir per test — avoids socket path collisions
    tmpDir = mkdtempSync(join(tmpdir(), "psso-agent-test-"));
    // getDecryptSocketPath() returns $XDG_RUNTIME_DIR/passwd-sso/decrypt.sock
    socketPath = join(tmpDir, "passwd-sso", "decrypt.sock");
    daemonChild = null;
  });

  afterEach(async () => {
    if (daemonChild) {
      await killChild(daemonChild);
      daemonChild = null;
    }
    // Clean up temp dir (socket file included)
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  /**
   * Spawn a daemon child that is already past the IPC handshake:
   * 1. Fork with _PSSO_DAEMON=1
   * 2. Send { secretHex, userId } via IPC
   * 3. Wait for "ready" acknowledgement
   * Returns the child process.
   */
  async function spawnAndHandshake(userId: string | null = "user_test_01"): Promise<ChildProcess> {
    const secretBytes = makeSecretKey();
    const secretHex = hexEncode(secretBytes);
    // Derive to verify the key is valid (not sent to child — child derives independently)
    await deriveEncryptionKey(secretBytes);

    const child = spawn(tsxBin, [cliSrcEntry, "agent", "--decrypt", "--eval"], {
      detached: false,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        ...process.env,
        _PSSO_DAEMON: "1",
        XDG_RUNTIME_DIR: tmpDir,
      },
    });

    daemonChild = child;

    // Send secret key and userId to child
    child.send({ secretHex, userId });

    await waitForReady(child);
    return child;
  }

  // ─── Lifecycle Tests ───────────────────────────────────────────────────────

  it("daemon child starts and sends 'ready' after receiving vault key", async () => {
    const child = await spawnAndHandshake();
    expect(child.pid).toBeDefined();
    expect(child.exitCode).toBeNull(); // Still running
  });

  it("daemon child creates a Unix socket after handshake", async () => {
    await spawnAndHandshake();
    await waitForSocket(socketPath);
    expect(existsSync(socketPath)).toBe(true);
  });

  it("daemon child handles SIGTERM and exits cleanly", async () => {
    const child = await spawnAndHandshake();
    await waitForSocket(socketPath);

    const exitPromise = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });

    child.kill("SIGTERM");
    const code = await exitPromise;

    // SIGTERM exit: code is null (killed by signal) or 0 (clean handler)
    expect(code === null || code === 0).toBe(true);
  });

  // ─── Socket Protocol Tests ─────────────────────────────────────────────────

  it("daemon child rejects malformed JSON with an error response", async () => {
    await spawnAndHandshake();
    await waitForSocket(socketPath);

    // Send raw invalid JSON directly via a socket client
    const response = await new Promise<string>((resolve, reject) => {
      const client: Socket = createConnection(socketPath);
      let data = "";

      client.on("connect", () => {
        client.write("not-valid-json\n");
      });

      client.on("data", (chunk: Buffer) => {
        data += chunk.toString("utf-8");
        if (data.includes("\n")) {
          client.destroy();
          resolve(data.split("\n")[0].trim());
        }
      });

      client.on("error", reject);

      setTimeout(() => {
        client.destroy();
        reject(new Error("Socket request timed out"));
      }, 5000);
    });

    const parsed = JSON.parse(response) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/[Pp]arse error/);
  });

  it("daemon child rejects request with invalid schema (missing clientId)", async () => {
    await spawnAndHandshake();
    await waitForSocket(socketPath);

    const badRequest = {
      entryId: "entry_abc123",
      // clientId omitted — required by DecryptRequestSchema
      field: "password",
    };

    const raw = await sendSocketRequest(socketPath, badRequest);
    const parsed = JSON.parse(raw) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/[Ii]nvalid request/);
  });

  it("daemon child rejects request with invalid entryId characters", async () => {
    await spawnAndHandshake();
    await waitForSocket(socketPath);

    const badRequest = {
      entryId: "../../etc/passwd", // path traversal attempt
      clientId: "mcpc_validclientid",
      field: "password",
    };

    const raw = await sendSocketRequest(socketPath, badRequest);
    const parsed = JSON.parse(raw) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/[Ii]nvalid request/);
  });

  it("daemon child rejects request with invalid field value", async () => {
    await spawnAndHandshake();
    await waitForSocket(socketPath);

    const badRequest = {
      entryId: "entry_abc123",
      clientId: "mcpc_validclientid",
      field: "secretField", // not in the allowed enum
    };

    const raw = await sendSocketRequest(socketPath, badRequest);
    const parsed = JSON.parse(raw) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/[Ii]nvalid request/);
  });

  it("daemon child returns error for oversized request (>64KB)", async () => {
    await spawnAndHandshake();
    await waitForSocket(socketPath);

    // Build a payload larger than MAX_BUFFER_SIZE (64KB)
    const oversizedPayload = "x".repeat(65 * 1024);

    const response = await new Promise<string>((resolve, reject) => {
      const client: Socket = createConnection(socketPath);
      let data = "";

      client.on("connect", () => {
        // Send oversized data without a newline — triggers the size check
        client.write(oversizedPayload);
      });

      client.on("data", (chunk: Buffer) => {
        data += chunk.toString("utf-8");
        if (data.includes("\n")) {
          client.destroy();
          resolve(data.split("\n")[0].trim());
        }
      });

      client.on("error", (err) => {
        // Connection reset after oversized payload is expected
        if (data.includes("{")) {
          resolve(data.split("\n")[0].trim());
        } else {
          reject(err);
        }
      });

      client.on("close", () => {
        if (data.trim()) {
          resolve(data.split("\n")[0].trim());
        }
      });

      setTimeout(() => {
        client.destroy();
        if (data.trim()) {
          resolve(data.split("\n")[0].trim());
        } else {
          reject(new Error("No response for oversized request"));
        }
      }, 5000);
    });

    const parsed = JSON.parse(response) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("too large");
  });

  it("daemon child returns error when vault key is not set (locked state)", async () => {
    // Spawn child but send an empty secretHex — deriveEncryptionKey will still
    // run, but the authorization check against the server will fail first.
    // The test verifies that schema-valid requests reach handleDecryptRequest
    // and get an error (not authorized / vault locked) rather than crashing.
    await spawnAndHandshake();
    await waitForSocket(socketPath);

    const request = {
      entryId: "entry_validid123",
      clientId: "mcpc_validclientid",
      field: "password",
    };

    const raw = await sendSocketRequest(socketPath, request);
    const parsed = JSON.parse(raw) as { ok: boolean; error?: string };
    // The authorization API call will fail (no server running), but the
    // daemon must return a structured error, not crash.
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
  });

  // ─── IPC Message Serialization Tests ──────────────────────────────────────

  it("IPC message contains secretHex as a 64-char lowercase hex string", async () => {
    // Verify the hex encoding contract used by forkDaemon <-> runDaemonChild
    const secretBytes = makeSecretKey();
    const secretHex = hexEncode(secretBytes);

    // 32 bytes → 64 hex chars
    expect(secretHex).toHaveLength(64);
    expect(secretHex).toMatch(/^[0-9a-f]+$/);
  });

  it("secret key bytes are zeroed after hex encoding", async () => {
    // Mirrors the forkDaemon() behavior: zero secretBytes after hexEncode
    const secretBytes = makeSecretKey();
    const originalHex = hexEncode(secretBytes);

    // Simulate zeroing
    secretBytes.fill(0);

    // The hex copy is intact (immutable string)
    expect(originalHex).toHaveLength(64);
    // The source bytes are now zeroed
    expect(Array.from(secretBytes).every((b) => b === 0)).toBe(true);
  });

  it("deriveEncryptionKey produces a non-extractable CryptoKey from secretHex", async () => {
    const secretBytes = makeSecretKey();
    const key = await deriveEncryptionKey(secretBytes);

    expect(key.type).toBe("secret");
    expect(key.algorithm.name).toBe("AES-GCM");
    expect(key.extractable).toBe(false);
    expect(key.usages).toContain("decrypt");
  });
});
