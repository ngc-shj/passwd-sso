/**
 * SSH agent Unix domain socket server.
 *
 * Creates a Unix socket that implements the SSH agent protocol (RFC 9987),
 * serving keys from the passwd-sso vault. Supports:
 *   - REQUEST_IDENTITIES (11)
 *   - SIGN_REQUEST (13) — with per-signature server authorization
 *   - REMOVE_ALL_IDENTITIES (19)
 *   - EXTENSION (27): query, session-bind@openssh.com
 */

import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { mkdirSync, lstatSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  readUint32,
  readString,
  encodeString,
  SSH2_AGENTC_REQUEST_IDENTITIES,
  SSH2_AGENTC_SIGN_REQUEST,
  SSH_AGENTC_REMOVE_ALL_IDENTITIES,
  SSH_AGENTC_EXTENSION,
  buildFailure,
  buildSuccess,
  buildIdentitiesAnswer,
  buildSignResponse,
  buildExtensionResponse,
  readExtensionRequest,
} from "./ssh-agent-protocol.js";
import {
  getLoadedKeys,
  findKeyByBlob,
  signData,
  clearKeys,
} from "./ssh-key-agent.js";
import {
  parseSessionBind,
  verifySessionBind,
  fingerprintPublicKey,
} from "./ssh-session-bind.js";
import type { SessionBinding } from "./ssh-session-bind.js";
import { authorizeSign as defaultAuthorizeSign } from "./ssh-sign-authorizer.js";
import { confirmSign as defaultConfirmSign } from "./ssh-confirm.js";

// ─── Connection context ────────────────────────────────────────

/** Per-connection state: the verified session-bind from session-bind@openssh.com */
export type ConnectionContext = { binding: SessionBinding | null };

// ─── Injected dependencies ─────────────────────────────────────

// Module-level, injectable so tests can replace them without real HTTP/TTY.
type AuthorizeFn = typeof defaultAuthorizeSign;
type ConfirmFn = typeof defaultConfirmSign;

let _authorizeSign: AuthorizeFn = defaultAuthorizeSign;
let _confirmSign: ConfirmFn = defaultConfirmSign;

/**
 * Inject authorize/confirm dependencies.
 * Must be called before the first connection. Mirrors the setEncryptionKey pattern.
 */
export function setAgentDeps(deps: {
  authorizeSign?: AuthorizeFn;
  confirmSign?: ConfirmFn;
}): void {
  if (deps.authorizeSign !== undefined) _authorizeSign = deps.authorizeSign;
  if (deps.confirmSign !== undefined) _confirmSign = deps.confirmSign;
}

// ─── Message handler ───────────────────────────────────────────

/**
 * Handle a single SSH agent protocol message.
 * Exported for unit testing (mirrors agent-decrypt.ts).
 */
export async function handleMessage(
  msgBuf: Buffer,
  ctx: ConnectionContext,
): Promise<Buffer> {
  if (msgBuf.length < 1) return buildFailure();

  const msgType = msgBuf[0];

  switch (msgType) {
    case SSH2_AGENTC_REQUEST_IDENTITIES: {
      const keys = getLoadedKeys();
      return buildIdentitiesAnswer(
        keys.map((k) => ({
          publicKeyBlob: k.publicKeyBlob,
          comment: k.comment,
        })),
      );
    }

    case SSH2_AGENTC_SIGN_REQUEST: {
      try {
        let offset = 1;

        // Read key blob
        const { data: keyBlob, nextOffset: afterKey } = readString(msgBuf, offset);
        offset = afterKey;

        // Read data to sign
        const { data: dataToSign, nextOffset: afterData } = readString(msgBuf, offset);
        offset = afterData;

        // Read flags
        const flags = offset + 4 <= msgBuf.length ? readUint32(msgBuf, offset) : 0;

        // Resolve key
        const key = findKeyByBlob(keyBlob);
        if (!key) return buildFailure();

        // Per-key confirmation gate
        if (key.requireReprompt) {
          const label = key.comment || key.entryId;
          const allowed = await _confirmSign(label);
          if (!allowed) return buildFailure();
        }

        // Per-signature server authorization
        const fingerprint = fingerprintPublicKey(key.publicKeyBlob);
        const authorized = await _authorizeSign({
          keyId: key.entryId,
          fingerprint,
          binding: ctx.binding,
        });
        if (!authorized) return buildFailure();

        // Perform signing locally
        const signature = signData(key, dataToSign, flags);
        return buildSignResponse(signature);
      } catch {
        return buildFailure();
      }
    }

    case SSH_AGENTC_REMOVE_ALL_IDENTITIES: {
      clearKeys();
      return buildSuccess();
    }

    case SSH_AGENTC_EXTENSION: {
      const { extName, rest } = readExtensionRequest(msgBuf);

      if (extName === "query") {
        // Advertise supported extension names as a sequence of SSH strings.
        // OpenSSH PROTOCOL.agent: query response body = concatenated string(name) entries.
        const payload = Buffer.concat([
          encodeString("query"),
          encodeString("session-bind@openssh.com"),
        ]);
        return buildExtensionResponse(payload);
      }

      if (extName === "session-bind@openssh.com") {
        try {
          const parsed = parseSessionBind(rest);
          if (!verifySessionBind(parsed)) return buildFailure();

          ctx.binding = {
            hostKeyFingerprint: fingerprintPublicKey(parsed.hostKeyBlob),
            forwarded: parsed.isForwarding,
          };
          return buildSuccess();
        } catch {
          return buildFailure();
        }
      }

      // Unknown extension — RFC 9987 requires an empty SSH_AGENT_FAILURE.
      return buildFailure();
    }

    default:
      return buildFailure();
  }
}

// ─── Connection handler ────────────────────────────────────────

/**
 * Handle a connected client socket with sequential, in-order message processing.
 *
 * RFC 9987 requires replies in the same order as requests. The async sign path
 * (authorize + optional confirm) would allow a second reply to overtake the
 * first if handled concurrently. We prevent this with a single-in-flight drain:
 * the data handler enqueues complete frames into a per-connection buffer, then
 * the drain loop processes one frame at a time, awaiting each reply before
 * dequeuing the next.
 *
 * Exported for unit testing (mirrors agent-decrypt.ts).
 */
export function handleConnection(socket: Socket): void {
  const ctx: ConnectionContext = { binding: null };
  let buffer = Buffer.alloc(0);
  let isProcessing = false;

  async function drain(): Promise<void> {
    if (isProcessing) return;
    isProcessing = true;

    try {
      while (buffer.length >= 4) {
        const msgLen = readUint32(buffer, 0);

        // Reject absurdly large messages before dequeuing (DoS protection)
        if (msgLen > 256 * 1024) {
          socket.destroy();
          buffer = Buffer.alloc(0);
          return;
        }

        if (buffer.length < 4 + msgLen) break; // Need more data

        const msgBuf = buffer.subarray(4, 4 + msgLen);
        buffer = buffer.subarray(4 + msgLen);

        let reply: Buffer;
        try {
          reply = await handleMessage(msgBuf, ctx);
        } catch {
          reply = buildFailure();
        }

        socket.write(reply);
      }
    } finally {
      isProcessing = false;
    }
  }

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    void drain();
  });

  socket.on("error", () => {
    // Silently handle client disconnects
  });
}

// ─── Server lifecycle ──────────────────────────────────────────

let server: Server | null = null;
let socketPath: string | null = null;

/**
 * Get the socket directory path.
 * Prefers $XDG_RUNTIME_DIR/passwd-sso/, falls back to /tmp/passwd-sso-<uid>/
 */
function getSocketDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return join(xdg, "passwd-sso");

  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Cannot determine user ID for socket directory");
  }
  return join("/tmp", `passwd-sso-${uid}`);
}

/**
 * Create the socket directory with proper permissions.
 * Validates ownership and mode to prevent symlink attacks.
 */
function ensureSocketDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Verify ownership and permissions (TOCTOU mitigation — lstatSync to avoid following symlinks)
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(
      `Socket path ${dir} is not a directory (possible symlink attack)`,
    );
  }
  const uid = process.getuid?.();

  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(
      `Socket directory ${dir} is owned by uid ${stat.uid}, expected ${uid}`,
    );
  }

  const mode = stat.mode & 0o7777;
  if (mode !== 0o700) {
    throw new Error(
      `Socket directory ${dir} has mode ${mode.toString(8)}, expected 700`,
    );
  }
}

/**
 * Start the SSH agent socket server.
 *
 * @returns The socket path for SSH_AUTH_SOCK
 */
export function startAgent(): string {
  if (process.platform === "win32") {
    throw new Error(
      "SSH agent is not supported on Windows. Unix domain sockets are required.",
    );
  }

  if (server) {
    throw new Error("SSH agent is already running");
  }

  const dir = getSocketDir();
  ensureSocketDir(dir);

  const path = join(dir, `agent.${process.pid}.sock`);

  // Clean up stale socket file
  try {
    unlinkSync(path);
  } catch {
    // File doesn't exist, that's fine
  }

  server = createServer(handleConnection);
  server.listen(path, () => {
    // Set socket file permissions to owner-only
    chmodSync(path, 0o600);
  });

  socketPath = path;

  // Clean up on process exit
  const cleanup = () => {
    stopAgent();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  return path;
}

/**
 * Stop the SSH agent socket server.
 */
export function stopAgent(): void {
  if (server) {
    server.close();
    server = null;
  }

  if (socketPath) {
    try {
      unlinkSync(socketPath);
    } catch {
      // Already cleaned up
    }
    socketPath = null;
  }
}

/**
 * Get the current socket path, or null if not running.
 */
export function getSocketPath(): string | null {
  return socketPath;
}
