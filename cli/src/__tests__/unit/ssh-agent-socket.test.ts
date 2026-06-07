/**
 * Tests for ssh-agent-socket.ts
 *
 * Drives the real exported handleConnection/handleMessage via a MockSocket harness.
 * Injected authorizeSign/confirmSign spies replace real HTTP/TTY calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  readUint32,
  encodeString,
  frameMessage,
  SSH2_AGENTC_REQUEST_IDENTITIES,
  SSH2_AGENTC_SIGN_REQUEST,
  SSH_AGENTC_REMOVE_ALL_IDENTITIES,
  SSH_AGENTC_EXTENSION,
  SSH_AGENT_SUCCESS,
  SSH2_AGENT_FAILURE,
  SSH_AGENT_EXTENSION_RESPONSE,
} from "../../lib/ssh-agent-protocol.js";
// ─── Mock dependencies that the socket module imports ─────────────────────────

vi.mock("../../lib/ssh-key-agent.js", () => ({
  getLoadedKeys: vi.fn(() => []),
  findKeyByBlob: vi.fn(() => undefined),
  signData: vi.fn(() => Buffer.from("fake-sig")),
  clearKeys: vi.fn(),
}));

vi.mock("../../lib/ssh-session-bind.js", () => ({
  parseSessionBind: vi.fn(),
  verifySessionBind: vi.fn(() => false),
  fingerprintPublicKey: vi.fn((blob: Buffer) => `SHA256:${blob.toString("hex").slice(0, 10)}`),
}));

// ssh-sign-authorizer and ssh-confirm are injected via setAgentDeps — no need to vi.mock them.

const {
  getLoadedKeys,
  findKeyByBlob,
  signData,
  clearKeys,
} = await import("../../lib/ssh-key-agent.js");

const {
  parseSessionBind,
  verifySessionBind,
  fingerprintPublicKey,
} = await import("../../lib/ssh-session-bind.js");

const {
  handleConnection,
  handleMessage,
  setAgentDeps,
} = await import("../../lib/ssh-agent-socket.js");

// ─── Mock Socket ─────────────────────────────────────────────────────────────

class MockSocket extends EventEmitter {
  written: Buffer[] = [];
  destroyed = false;

  write(data: Buffer): boolean {
    this.written.push(data);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Simulate receiving a binary SSH agent frame from the client */
  receiveFrame(msgBody: Buffer): void {
    this.emit("data", frameMessage(msgBody));
  }

  /** Build and send a typed message body */
  receiveMessage(type: number, ...parts: Buffer[]): void {
    const body = Buffer.concat([Buffer.from([type]), ...parts]);
    this.receiveFrame(body);
  }
}

// ─── SSH frame helpers ────────────────────────────────────────────────────────

/** Read the reply type byte from a framed response */
function replyType(buf: Buffer): number {
  return buf[4];
}

/** Build a SIGN_REQUEST body */
function makeSignRequest(keyBlob: Buffer, data: Buffer, flags = 0): Buffer {
  const flagBuf = Buffer.alloc(4);
  flagBuf.writeUInt32BE(flags, 0);
  return Buffer.concat([
    Buffer.from([SSH2_AGENTC_SIGN_REQUEST]),
    encodeString(keyBlob),
    encodeString(data),
    flagBuf,
  ]);
}

/** Build an EXTENSION body */
function makeExtension(name: string, payload = Buffer.alloc(0)): Buffer {
  return Buffer.concat([
    Buffer.from([SSH_AGENTC_EXTENSION]),
    encodeString(name),
    payload,
  ]);
}

// ─── Common mocks / spies ─────────────────────────────────────────────────────

const mockAuthorizeSign = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
const mockConfirmSign = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: key not found, deny all
  vi.mocked(getLoadedKeys).mockReturnValue([]);
  vi.mocked(findKeyByBlob).mockReturnValue(undefined);
  vi.mocked(clearKeys).mockReturnValue(undefined);
  vi.mocked(verifySessionBind).mockReturnValue(false);
  vi.mocked(fingerprintPublicKey).mockImplementation((blob) =>
    `SHA256:${blob.toString("hex").slice(0, 10)}`,
  );

  mockAuthorizeSign.mockResolvedValue(false);
  mockConfirmSign.mockResolvedValue(true); // default: confirm grants

  setAgentDeps({
    authorizeSign: mockAuthorizeSign,
    confirmSign: mockConfirmSign,
  });
});

// ─── REMOVE_ALL_IDENTITIES ────────────────────────────────────────────────────

describe("REMOVE_ALL_IDENTITIES (19)", () => {
  it("returns SSH_AGENT_SUCCESS and calls clearKeys", async () => {
    const ctx = { binding: null };
    const body = Buffer.from([SSH_AGENTC_REMOVE_ALL_IDENTITIES]);
    const reply = await handleMessage(body, ctx);

    expect(replyType(reply)).toBe(SSH_AGENT_SUCCESS);
    expect(vi.mocked(clearKeys)).toHaveBeenCalledOnce();
  });

  it("via handleConnection: REMOVE_ALL → SUCCESS frame arrives", async () => {
    const socket = new MockSocket();
    handleConnection(socket as never);

    socket.receiveMessage(SSH_AGENTC_REMOVE_ALL_IDENTITIES);

    await vi.waitFor(() => {
      expect(socket.written.length).toBeGreaterThan(0);
    });

    expect(replyType(socket.written[0])).toBe(SSH_AGENT_SUCCESS);
    expect(vi.mocked(clearKeys)).toHaveBeenCalledOnce();
  });
});

// ─── EXTENSION — unknown ──────────────────────────────────────────────────────

describe("EXTENSION with unknown name", () => {
  it("returns SSH2_AGENT_FAILURE for an unknown extension", async () => {
    const ctx = { binding: null };
    const body = makeExtension("unknown-ext@example.com");
    const reply = await handleMessage(body, ctx);

    expect(replyType(reply)).toBe(SSH2_AGENT_FAILURE);
  });
});

// ─── EXTENSION — query ────────────────────────────────────────────────────────

describe("EXTENSION query", () => {
  it("returns EXTENSION_RESPONSE containing 'query' and 'session-bind@openssh.com'", async () => {
    const ctx = { binding: null };
    const body = makeExtension("query");
    const reply = await handleMessage(body, ctx);

    expect(replyType(reply)).toBe(SSH_AGENT_EXTENSION_RESPONSE);

    // The payload starts at byte 5 (after 4-byte length + 1 type byte).
    // It should contain SSH-string-encoded names.
    const payload = reply.subarray(5);

    // Read first name
    const nameLen1 = readUint32(payload, 0);
    const name1 = payload.subarray(4, 4 + nameLen1).toString("utf-8");
    expect(name1).toBe("query");

    // Read second name
    const offset2 = 4 + nameLen1;
    const nameLen2 = readUint32(payload, offset2);
    const name2 = payload.subarray(offset2 + 4, offset2 + 4 + nameLen2).toString("utf-8");
    expect(name2).toBe("session-bind@openssh.com");
  });
});

// ─── EXTENSION — session-bind ─────────────────────────────────────────────────

describe("EXTENSION session-bind@openssh.com", () => {
  it("returns FAILURE when verifySessionBind returns false", async () => {
    vi.mocked(parseSessionBind).mockReturnValue({
      hostKeyBlob: Buffer.from("fake-host-key"),
      sessionId: Buffer.from("session"),
      signature: Buffer.from("sig"),
      isForwarding: false,
    });
    vi.mocked(verifySessionBind).mockReturnValue(false);

    const ctx = { binding: null };
    const body = makeExtension("session-bind@openssh.com", Buffer.from("payload"));
    const reply = await handleMessage(body, ctx);

    expect(replyType(reply)).toBe(SSH2_AGENT_FAILURE);
    expect(ctx.binding).toBeNull();
  });

  it("returns SUCCESS and stores binding when verifySessionBind returns true", async () => {
    const fakeHostKeyBlob = Buffer.from("host-key-bytes");
    const fakeFingerprint = "SHA256:DEADBEEF";

    vi.mocked(parseSessionBind).mockReturnValue({
      hostKeyBlob: fakeHostKeyBlob,
      sessionId: Buffer.from("session-id"),
      signature: Buffer.from("valid-sig"),
      isForwarding: false,
    });
    vi.mocked(verifySessionBind).mockReturnValue(true);
    vi.mocked(fingerprintPublicKey).mockReturnValue(fakeFingerprint);

    const ctx = { binding: null };
    const body = makeExtension("session-bind@openssh.com", Buffer.from("payload"));
    const reply = await handleMessage(body, ctx);

    expect(replyType(reply)).toBe(SSH_AGENT_SUCCESS);
    expect(ctx.binding).toEqual({
      hostKeyFingerprint: fakeFingerprint,
      forwarded: false,
    });
  });

  it("forwarded:true is stored in binding", async () => {
    const fakeHostKeyBlob = Buffer.from("forwarded-host-key");

    vi.mocked(parseSessionBind).mockReturnValue({
      hostKeyBlob: fakeHostKeyBlob,
      sessionId: Buffer.from("session-id"),
      signature: Buffer.from("valid-sig"),
      isForwarding: true,
    });
    vi.mocked(verifySessionBind).mockReturnValue(true);
    vi.mocked(fingerprintPublicKey).mockReturnValue("SHA256:FWD");

    const ctx = { binding: null };
    const body = makeExtension("session-bind@openssh.com", Buffer.from("payload"));
    await handleMessage(body, ctx);

    expect(ctx.binding?.forwarded).toBe(true);
  });
});

// ─── SIGN_REQUEST dispatch ────────────────────────────────────────────────────

describe("SIGN_REQUEST (13)", () => {
  const fakeKeyBlob = Buffer.from("fake-public-key-blob");
  const fakeData = Buffer.from("data-to-sign");

  function makeFakeKey(requireReprompt = false) {
    return {
      entryId: "entry-abc123",
      requireReprompt,
      publicKeyBlob: fakeKeyBlob,
      comment: "test@host",
      pem: "",
      passphrase: undefined,
      keyObject: {} as never,
      keyType: "ed25519" as const,
    };
  }

  it("returns FAILURE when key is not found", async () => {
    vi.mocked(findKeyByBlob).mockReturnValue(undefined);

    const ctx = { binding: null };
    const body = makeSignRequest(fakeKeyBlob, fakeData);
    const reply = await handleMessage(body, ctx);

    expect(replyType(reply)).toBe(SSH2_AGENT_FAILURE);
  });

  it("returns FAILURE when authorizeSign returns false", async () => {
    vi.mocked(findKeyByBlob).mockReturnValue(makeFakeKey(false));
    mockAuthorizeSign.mockResolvedValue(false);

    const ctx = { binding: null };
    const body = makeSignRequest(fakeKeyBlob, fakeData);
    const reply = await handleMessage(body, ctx);

    expect(replyType(reply)).toBe(SSH2_AGENT_FAILURE);
  });

  it("returns SIGN_RESPONSE (14) when authorized", async () => {
    vi.mocked(findKeyByBlob).mockReturnValue(makeFakeKey(false));
    mockAuthorizeSign.mockResolvedValue(true);

    const ctx = { binding: null };
    const body = makeSignRequest(fakeKeyBlob, fakeData);
    const reply = await handleMessage(body, ctx);

    expect(replyType(reply)).toBe(14); // SSH2_AGENT_SIGN_RESPONSE
    expect(vi.mocked(signData)).toHaveBeenCalled();
  });

  it("calls authorizeSign with the correct fingerprint and no binding", async () => {
    const fingerprint = "SHA256:TESTKEY";
    vi.mocked(fingerprintPublicKey).mockReturnValue(fingerprint);
    vi.mocked(findKeyByBlob).mockReturnValue(makeFakeKey(false));
    mockAuthorizeSign.mockResolvedValue(true);

    const ctx = { binding: null };
    const body = makeSignRequest(fakeKeyBlob, fakeData);
    await handleMessage(body, ctx);

    expect(mockAuthorizeSign).toHaveBeenCalledWith({
      keyId: "entry-abc123",
      fingerprint,
      binding: null,
    });
  });

  it("calls authorizeSign with the binding when session-bind is set", async () => {
    const binding = {
      hostKeyFingerprint: "SHA256:HOSTKEY",
      forwarded: false,
    };
    vi.mocked(findKeyByBlob).mockReturnValue(makeFakeKey(false));
    mockAuthorizeSign.mockResolvedValue(true);

    const ctx = { binding };
    const body = makeSignRequest(fakeKeyBlob, fakeData);
    await handleMessage(body, ctx);

    expect(mockAuthorizeSign).toHaveBeenCalledWith(
      expect.objectContaining({ binding }),
    );
  });

  it("calls confirmSign when requireReprompt is true", async () => {
    vi.mocked(findKeyByBlob).mockReturnValue(makeFakeKey(true));
    mockConfirmSign.mockResolvedValue(true);
    mockAuthorizeSign.mockResolvedValue(true);

    const ctx = { binding: null };
    const body = makeSignRequest(fakeKeyBlob, fakeData);
    await handleMessage(body, ctx);

    expect(mockConfirmSign).toHaveBeenCalledWith("test@host");
  });

  it("returns FAILURE when requireReprompt key is denied by confirmSign", async () => {
    vi.mocked(findKeyByBlob).mockReturnValue(makeFakeKey(true));
    mockConfirmSign.mockResolvedValue(false);

    const ctx = { binding: null };
    const body = makeSignRequest(fakeKeyBlob, fakeData);
    const reply = await handleMessage(body, ctx);

    expect(replyType(reply)).toBe(SSH2_AGENT_FAILURE);
    // authorizeSign should NOT be called if confirmSign denied
    expect(mockAuthorizeSign).not.toHaveBeenCalled();
  });

  it("does not call confirmSign when requireReprompt is false", async () => {
    vi.mocked(findKeyByBlob).mockReturnValue(makeFakeKey(false));
    mockAuthorizeSign.mockResolvedValue(true);

    const ctx = { binding: null };
    const body = makeSignRequest(fakeKeyBlob, fakeData);
    await handleMessage(body, ctx);

    expect(mockConfirmSign).not.toHaveBeenCalled();
  });
});

// ─── REPLY ORDERING (vacuous-guard) ──────────────────────────────────────────

describe("Reply ordering: single-in-flight drain", () => {
  it("does not write any reply while authorizeSign is pending, then writes both in order", async () => {
    const fakeKeyBlob = Buffer.from("key-for-ordering-test");
    const fakeKey = {
      entryId: "entry-order",
      requireReprompt: false,
      publicKeyBlob: fakeKeyBlob,
      comment: "order-test",
      pem: "",
      passphrase: undefined,
      keyObject: {} as never,
      keyType: "ed25519" as const,
    };

    vi.mocked(findKeyByBlob).mockReturnValue(fakeKey);
    vi.mocked(signData).mockReturnValue(Buffer.from("sig"));

    // Use a deferred promise to control when authorizeSign resolves.
    let resolveAuth!: (v: boolean) => void;
    const authPending = new Promise<boolean>((resolve) => {
      resolveAuth = resolve;
    });
    mockAuthorizeSign.mockReturnValueOnce(authPending); // first call deferred
    mockAuthorizeSign.mockResolvedValue(true);           // second call resolves immediately

    const socket = new MockSocket();
    handleConnection(socket as never);

    // Send two SIGN frames back-to-back while the first is still pending.
    const signBody = makeSignRequest(fakeKeyBlob, Buffer.from("data1"));
    const signBody2 = makeSignRequest(fakeKeyBlob, Buffer.from("data2"));

    socket.receiveFrame(signBody);
    socket.receiveFrame(signBody2);

    // While the first is awaiting authorizeSign, no writes should have occurred.
    // Give the microtask queue a chance to advance but keep the deferred auth pending.
    await new Promise((r) => setTimeout(r, 20));
    expect(socket.written.length).toBe(0);

    // Resolve the first auth (true → sign succeeds).
    resolveAuth(true);

    // Wait for both replies to arrive.
    await vi.waitFor(() => {
      expect(socket.written.length).toBeGreaterThanOrEqual(2);
    });

    // Both replies must have arrived in frame order.
    expect(replyType(socket.written[0])).toBe(14); // SIGN_RESPONSE for frame 1
    expect(replyType(socket.written[1])).toBe(14); // SIGN_RESPONSE for frame 2
  });
});

// ─── CONNECTION ISOLATION ─────────────────────────────────────────────────────

describe("Connection isolation: binding does not leak between connections", () => {
  it("connection A's session-bind does not affect connection B's SIGN call", async () => {
    const fakeKeyBlob = Buffer.from("isolation-test-key");
    const fakeKey = {
      entryId: "entry-iso",
      requireReprompt: false,
      publicKeyBlob: fakeKeyBlob,
      comment: "iso@test",
      pem: "",
      passphrase: undefined,
      keyObject: {} as never,
      keyType: "ed25519" as const,
    };

    vi.mocked(findKeyByBlob).mockReturnValue(fakeKey);

    const hostFingerprint = "SHA256:HOSTKEY_A";
    vi.mocked(parseSessionBind).mockReturnValue({
      hostKeyBlob: Buffer.from("host-a-key"),
      sessionId: Buffer.from("session-a"),
      signature: Buffer.from("sig-a"),
      isForwarding: false,
    });
    vi.mocked(verifySessionBind).mockReturnValue(true);
    vi.mocked(fingerprintPublicKey).mockReturnValue(hostFingerprint);
    mockAuthorizeSign.mockResolvedValue(true);

    // Connection A: sends session-bind then SIGN
    const socketA = new MockSocket();
    handleConnection(socketA as never);

    socketA.receiveFrame(makeExtension("session-bind@openssh.com", Buffer.from("p")));

    await vi.waitFor(() => {
      expect(socketA.written.length).toBeGreaterThan(0);
    });
    expect(replyType(socketA.written[0])).toBe(SSH_AGENT_SUCCESS);

    // Clear the spy to track next call
    mockAuthorizeSign.mockClear();
    mockAuthorizeSign.mockResolvedValue(true);

    socketA.receiveFrame(makeSignRequest(fakeKeyBlob, Buffer.from("data-a")));

    await vi.waitFor(() => {
      expect(socketA.written.length).toBeGreaterThanOrEqual(2);
    });

    // The SIGN on connection A should have received the bound fingerprint.
    expect(mockAuthorizeSign).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ hostKeyFingerprint: hostFingerprint }),
      }),
    );

    // Connection B: separate socket — no session-bind sent.
    mockAuthorizeSign.mockClear();
    mockAuthorizeSign.mockResolvedValue(true);

    const socketB = new MockSocket();
    handleConnection(socketB as never);

    socketB.receiveFrame(makeSignRequest(fakeKeyBlob, Buffer.from("data-b")));

    await vi.waitFor(() => {
      expect(socketB.written.length).toBeGreaterThan(0);
    });

    // Connection B's authorizeSign must have received binding: null.
    expect(mockAuthorizeSign).toHaveBeenCalledWith(
      expect.objectContaining({ binding: null }),
    );
  });
});

// ─── REQUEST_IDENTITIES ───────────────────────────────────────────────────────

describe("REQUEST_IDENTITIES (11)", () => {
  it("returns the list of loaded keys", async () => {
    const fakeKey = {
      entryId: "e1",
      requireReprompt: false,
      publicKeyBlob: Buffer.from("blob1"),
      comment: "key1",
      pem: "",
      passphrase: undefined,
      keyObject: {} as never,
      keyType: "ed25519" as const,
    };
    vi.mocked(getLoadedKeys).mockReturnValue([fakeKey]);

    const ctx = { binding: null };
    const body = Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]);
    const reply = await handleMessage(body, ctx);

    // SSH2_AGENT_IDENTITIES_ANSWER = 12
    expect(replyType(reply)).toBe(12);
  });
});

// ─── Empty / unknown message ──────────────────────────────────────────────────

describe("Unknown message type", () => {
  it("returns FAILURE for an unknown type byte", async () => {
    const ctx = { binding: null };
    const body = Buffer.from([0xff]);
    const reply = await handleMessage(body, ctx);

    expect(replyType(reply)).toBe(SSH2_AGENT_FAILURE);
  });

  it("returns FAILURE for an empty message buffer", async () => {
    const ctx = { binding: null };
    const reply = await handleMessage(Buffer.alloc(0), ctx);

    expect(replyType(reply)).toBe(SSH2_AGENT_FAILURE);
  });
});
