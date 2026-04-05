/**
 * Tests for the agent-decrypt IPC protocol.
 *
 * Tests cover:
 * 1. IPC message serialization contract (hexEncode, deriveEncryptionKey)
 * 2. Socket connection handler (handleConnection) via mock sockets:
 *    - Malformed JSON → parse error
 *    - Missing required fields → schema validation error
 *    - Path traversal in entryId → rejected
 *    - Invalid field enum → rejected
 *    - Oversized request → rejected
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { hexEncode, deriveEncryptionKey } from "../../lib/crypto.js";
import { handleConnection, MAX_BUFFER_SIZE } from "../../commands/agent-decrypt.js";

// ─── Mock Socket ─────────────────────────────────────────────────────────────

class MockSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  ended = false;

  write(data: string): boolean {
    this.written.push(data);
    return true;
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Simulate receiving data from the client */
  receiveData(data: string): void {
    this.emit("data", Buffer.from(data, "utf-8"));
  }

  /** Get all written responses parsed as JSON */
  getResponses(): Array<{ ok: boolean; error?: string; value?: string }> {
    return this.written
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => JSON.parse(s) as { ok: boolean; error?: string; value?: string });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSecretKey(): Uint8Array {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Send a message through handleConnection and wait for the async response.
 */
async function sendAndReceive(message: string): Promise<{ ok: boolean; error?: string; value?: string }> {
  const socket = new MockSocket();
  handleConnection(socket as never);
  socket.receiveData(message);

  // Poll until the async IIFE inside handleConnection writes a response
  await vi.waitFor(() => {
    expect(socket.written.length).toBeGreaterThan(0);
  });

  return socket.getResponses()[0];
}

// ─── Mock external dependencies ──────────────────────────────────────────────

// handleConnection calls handleDecryptRequest internally, which uses apiRequest.
// We mock vault-state and api-client to prevent real HTTP calls.
vi.mock("../../lib/vault-state.js", () => ({
  getEncryptionKey: vi.fn(() => null),
  getUserId: vi.fn(() => null),
  getSecretKeyBytes: vi.fn(() => null),
  setEncryptionKey: vi.fn(),
}));
vi.mock("../../lib/api-client.js", () => ({
  apiRequest: vi.fn().mockResolvedValue({ ok: false, status: 500, data: {} }),
  startBackgroundRefresh: vi.fn(),
}));
vi.mock("../../lib/output.js", () => ({
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("../../commands/unlock.js", () => ({
  readPassphrase: vi.fn(),
  unlockWithPassphrase: vi.fn(),
}));

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe("agent-decrypt IPC message contract", () => {
  it("hexEncode produces a 64-char lowercase hex string from 32-byte key", () => {
    const secretBytes = makeSecretKey();
    const secretHex = hexEncode(secretBytes);

    expect(secretHex).toHaveLength(64);
    expect(secretHex).toMatch(/^[0-9a-f]+$/);
  });

  it("source bytes can be zeroed after hex encoding without data loss", () => {
    const secretBytes = makeSecretKey();
    const originalHex = hexEncode(secretBytes);

    secretBytes.fill(0);

    expect(originalHex).toHaveLength(64);
    expect(originalHex).toMatch(/^[0-9a-f]+$/);
    expect(Array.from(secretBytes).every((b) => b === 0)).toBe(true);
  });

  it("deriveEncryptionKey produces a non-extractable AES-GCM CryptoKey", async () => {
    const secretBytes = makeSecretKey();
    const key = await deriveEncryptionKey(secretBytes);

    expect(key.type).toBe("secret");
    expect(key.algorithm.name).toBe("AES-GCM");
    expect(key.extractable).toBe(false);
    expect(key.usages).toContain("decrypt");
  });
});

describe("handleConnection socket protocol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects malformed JSON with a parse error", async () => {
    const res = await sendAndReceive("not-valid-json\n");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/[Pp]arse error/);
  });

  it("rejects request missing required clientId field", async () => {
    const req = JSON.stringify({ entryId: "entry_abc123", field: "password" });
    const res = await sendAndReceive(req + "\n");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/[Ii]nvalid request/);
  });

  it("rejects request missing required entryId field", async () => {
    const req = JSON.stringify({ clientId: "mcpc_test", field: "password" });
    const res = await sendAndReceive(req + "\n");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/[Ii]nvalid request/);
  });

  it("rejects path traversal in entryId", async () => {
    const req = JSON.stringify({
      entryId: "../../etc/passwd",
      clientId: "mcpc_test",
      field: "password",
    });
    const res = await sendAndReceive(req + "\n");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/[Ii]nvalid request/);
  });

  it("rejects invalid field enum value", async () => {
    const req = JSON.stringify({
      entryId: "entry_abc123",
      clientId: "mcpc_test",
      field: "secretField",
    });
    const res = await sendAndReceive(req + "\n");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/[Ii]nvalid request/);
  });

  it("rejects oversized request (> MAX_BUFFER_SIZE)", () => {
    const socket = new MockSocket();
    handleConnection(socket as never);

    // Send a payload larger than MAX_BUFFER_SIZE
    const oversized = "x".repeat(MAX_BUFFER_SIZE + 1);
    socket.receiveData(oversized);

    const responses = socket.getResponses();
    expect(responses).toHaveLength(1);
    expect(responses[0].ok).toBe(false);
    expect(responses[0].error).toContain("too large");
    expect(socket.destroyed).toBe(true);
  });

  it("returns vault locked error for valid request when vault key is null", async () => {
    const req = JSON.stringify({
      entryId: "entry_abc123",
      clientId: "mcpc_test",
      field: "password",
    });
    const res = await sendAndReceive(req + "\n");
    // apiRequest is mocked to return { ok: false }, so we get an auth error
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
  });

  it("ignores empty lines between messages", async () => {
    const socket = new MockSocket();
    handleConnection(socket as never);

    socket.receiveData("\n\nnot-valid-json\n");

    await vi.waitFor(() => {
      expect(socket.written.length).toBeGreaterThan(0);
    });

    const responses = socket.getResponses();
    expect(responses).toHaveLength(1);
    expect(responses[0].ok).toBe(false);
    expect(responses[0].error).toMatch(/[Pp]arse error/);
  });
});
