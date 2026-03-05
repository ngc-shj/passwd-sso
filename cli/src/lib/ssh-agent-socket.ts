/**
 * SSH agent Unix domain socket server.
 *
 * Creates a Unix socket that implements the SSH agent protocol,
 * serving keys from the passwd-sso vault.
 */

import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { mkdirSync, lstatSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  readUint32,
  readString,
  SSH2_AGENTC_REQUEST_IDENTITIES,
  SSH2_AGENTC_SIGN_REQUEST,
  buildFailure,
  buildIdentitiesAnswer,
  buildSignResponse,
} from "./ssh-agent-protocol.js";
import { getLoadedKeys, findKeyByBlob, signData } from "./ssh-key-agent.js";

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
 * Handle a single SSH agent protocol message.
 */
function handleMessage(msgBuf: Buffer): Buffer {
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
        const { data: keyBlob, nextOffset: afterKey } = readString(
          msgBuf,
          offset,
        );
        offset = afterKey;

        // Read data to sign
        const { data, nextOffset: afterData } = readString(msgBuf, offset);
        offset = afterData;

        // Read flags
        const flags = offset + 4 <= msgBuf.length
          ? readUint32(msgBuf, offset)
          : 0;

        // Find the key
        const key = findKeyByBlob(keyBlob);
        if (!key) return buildFailure();

        // Perform signing
        const signature = signData(key, data, flags);
        return buildSignResponse(signature);
      } catch {
        return buildFailure();
      }
    }

    default:
      return buildFailure();
  }
}

/**
 * Handle data from a connected client.
 * SSH agent protocol uses length-prefixed messages.
 */
function handleConnection(socket: Socket): void {
  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    // Process complete messages
    while (buffer.length >= 4) {
      const msgLen = readUint32(buffer, 0);

      // Reject absurdly large messages (DoS protection)
      if (msgLen > 256 * 1024) {
        socket.destroy();
        return;
      }

      if (buffer.length < 4 + msgLen) break; // Need more data

      const msgBuf = buffer.subarray(4, 4 + msgLen);
      buffer = buffer.subarray(4 + msgLen);

      const response = handleMessage(msgBuf);
      socket.write(response);
    }
  });

  socket.on("error", () => {
    // Silently handle client disconnects
  });
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
