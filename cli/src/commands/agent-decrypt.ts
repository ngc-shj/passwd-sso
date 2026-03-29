/**
 * Decrypt agent — holds vault key in memory, serves decrypt requests via Unix socket.
 * Authorization is checked against the server for every request (no caching).
 *
 * Socket: $XDG_RUNTIME_DIR/passwd-sso/decrypt.sock
 * Protocol: newline-delimited JSON over Unix domain socket
 */

import { createServer } from "node:net";
import type { Socket } from "node:net";
import { spawn } from "node:child_process";
import { mkdirSync, lstatSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { apiRequest, startBackgroundRefresh } from "../lib/api-client.js";
import { decryptData, hexEncode } from "../lib/crypto.js";
import { buildPersonalEntryAAD } from "../lib/crypto-aad.js";
import { getEncryptionKey, getUserId, setEncryptionKey } from "../lib/vault-state.js";
import { readPassphrase, unlockWithPassphrase } from "./unlock.js";
import * as output from "../lib/output.js";

// ─── Input Validation Schema ───────────────────────────────────

const DecryptRequestSchema = z.object({
  entryId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  mcpTokenId: z.string().uuid(),
  field: z.enum(["password", "username", "url", "notes", "totp"]).default("password"),
});

type DecryptRequest = z.infer<typeof DecryptRequestSchema>;

// ─── Response Types ────────────────────────────────────────────

interface DecryptResponse {
  ok: boolean;
  value?: string;
  error?: string;
}

// ─── Vault Entry Types ─────────────────────────────────────────

interface VaultEntry {
  id: string;
  encryptedBlob: {
    ciphertext: string;
    iv: string;
    authTag: string;
  };
  aadVersion: number;
}

interface EntryBlob {
  password?: string;
  username?: string;
  url?: string;
  notes?: string;
  totp?: {
    secret: string;
    algorithm?: string;
    digits?: number;
    period?: number;
  };
  [key: string]: unknown;
}

// ─── Socket Path ───────────────────────────────────────────────

function getDecryptSocketPath(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (!xdg) {
    process.stderr.write(
      "Error: $XDG_RUNTIME_DIR is not set.\n" +
      "On Linux, this is typically /run/user/<uid>.\n" +
      "Ensure your session manager sets XDG_RUNTIME_DIR (systemd-logind or pam_systemd).\n",
    );
    process.exit(1);
  }
  return join(xdg, "passwd-sso", "decrypt.sock");
}

/**
 * Prepare the socket directory and validate ownership before binding.
 */
function prepareSocket(socketPath: string): void {
  const dir = join(socketPath, "..");

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Verify directory ownership (lstatSync avoids following symlinks)
  const dirStat = lstatSync(dir);
  if (!dirStat.isDirectory()) {
    process.stderr.write(`Error: ${dir} is not a directory (possible symlink attack)\n`);
    process.exit(1);
  }

  const uid = process.getuid?.();
  if (uid !== undefined && dirStat.uid !== uid) {
    process.stderr.write(
      `Error: Socket directory ${dir} is owned by uid ${dirStat.uid}, expected ${uid}\n`,
    );
    process.exit(1);
  }

  // Remove stale socket if present, verify ownership first
  try {
    const sockStat = lstatSync(socketPath);
    if (uid !== undefined && sockStat.uid !== uid) {
      process.stderr.write(
        `Error: Stale socket ${socketPath} is owned by uid ${sockStat.uid}, not removing\n`,
      );
      process.exit(1);
    }
    unlinkSync(socketPath);
  } catch {
    // Socket doesn't exist, that's fine
  }
}

// ─── Decrypt Request Handler ───────────────────────────────────

async function handleDecryptRequest(req: DecryptRequest): Promise<DecryptResponse> {
  // Step 1: Check authorization with server (no caching — ensures immediate revocation)
  const checkRes = await apiRequest<{ authorized: boolean; reason?: string }>(
    `/api/vault/delegation/check?mcpTokenId=${req.mcpTokenId}&entryId=${req.entryId}`,
  );

  if (!checkRes.ok || !checkRes.data.authorized) {
    const reason = checkRes.data.reason ?? "unauthorized";
    return { ok: false, error: `Not authorized: ${reason}` };
  }

  // Step 2: Fetch the vault entry
  const entryRes = await apiRequest<VaultEntry>(`/api/passwords/${req.entryId}`);
  if (!entryRes.ok) {
    return { ok: false, error: `Failed to fetch entry: HTTP ${entryRes.status}` };
  }

  const entry = entryRes.data;

  // Defense in depth: verify returned entry matches requested ID
  if (entry.id !== req.entryId) {
    return { ok: false, error: "Entry ID mismatch (server returned unexpected entry)" };
  }

  // Step 3: Decrypt with vault key
  const encryptionKey = getEncryptionKey();
  if (!encryptionKey) {
    return { ok: false, error: "Vault is locked" };
  }

  const userId = getUserId();

  try {
    const aad = entry.aadVersion >= 1 && userId
      ? buildPersonalEntryAAD(userId, entry.id)
      : undefined;

    const plaintext = await decryptData(entry.encryptedBlob, encryptionKey, aad);
    const blob: EntryBlob = JSON.parse(plaintext);

    // Step 4: Extract requested field
    const fieldValue = blob[req.field];
    if (fieldValue === undefined || fieldValue === null) {
      return { ok: false, error: `Field "${req.field}" not found in entry` };
    }

    // For totp field, return the secret as a string
    const value = typeof fieldValue === "object"
      ? JSON.stringify(fieldValue)
      : String(fieldValue);

    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      error: `Decrypt failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}

// ─── Connection Handler ────────────────────────────────────────

const MAX_BUFFER_SIZE = 64 * 1024; // 64KB — far more than any valid request

function handleConnection(socket: Socket): void {
  let buffer = "";

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");

    if (buffer.length > MAX_BUFFER_SIZE) {
      socket.write(JSON.stringify({ ok: false, error: "Request too large" }) + "\n");
      socket.destroy();
      buffer = "";
      return;
    }

    // Process complete newline-delimited JSON messages
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // Keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      void (async () => {
        let response: DecryptResponse;

        try {
          const raw = JSON.parse(trimmed) as unknown;
          const parsed = DecryptRequestSchema.safeParse(raw);

          if (!parsed.success) {
            response = {
              ok: false,
              error: `Invalid request: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
            };
          } else {
            response = await handleDecryptRequest(parsed.data);
          }
        } catch (err) {
          response = {
            ok: false,
            error: `Parse error: ${err instanceof Error ? err.message : "unknown error"}`,
          };
        }

        socket.write(JSON.stringify(response) + "\n");
        socket.end();
      })();
    }
  });

  socket.on("error", () => {
    // Silently handle client disconnects
  });
}

// ─── Main Command ──────────────────────────────────────────────

export interface DecryptAgentOptions {
  eval?: boolean;
}

export async function decryptAgentCommand(opts: DecryptAgentOptions): Promise<void> {
  if (process.platform === "win32") {
    process.stderr.write("Error: Decrypt agent is not supported on Windows.\n");
    process.exit(1);
  }

  // Internal daemon mode: receives vault key via IPC from parent
  if (process.env._PSSO_DAEMON === "1") {
    return runDaemonChild();
  }

  const socketPath = getDecryptSocketPath();

  // Prompt for passphrase via TTY — explicitly does NOT use PSSO_PASSPHRASE env
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "Error: No TTY available. The decrypt agent requires a TTY for passphrase input.\n" +
      "Run in an interactive terminal.\n",
    );
    process.exit(1);
  }

  const passphrase = await readPassphrase("Master passphrase: ");
  if (!passphrase) {
    process.stderr.write("Error: Passphrase is required.\n");
    process.exit(1);
  }

  const unlocked = await unlockWithPassphrase(passphrase);
  if (!unlocked) {
    process.exit(1);
  }

  if (opts.eval) {
    // Fork as background daemon, pass vault key via IPC
    return forkDaemon(socketPath);
  }

  // Foreground mode
  startForegroundAgent(socketPath);
}

/**
 * --eval mode: fork a detached child, pass vault key via IPC, output eval commands, exit.
 */
async function forkDaemon(socketPath: string): Promise<void> {
  const key = getEncryptionKey();
  if (!key) {
    process.stderr.write("Error: Vault key not available.\n");
    process.exit(1);
  }

  // Export raw key bytes for IPC transfer
  const rawKeyBytes = await crypto.subtle.exportKey("raw", key);
  const keyHex = hexEncode(rawKeyBytes);
  const userId = getUserId();

  // Reconstruct args for child: remove --eval, add internal daemon flag
  const childArgs = process.argv.slice(1).filter((a) => a !== "--eval");

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, _PSSO_DAEMON: "1" },
  });

  // Send vault key + userId to child via IPC
  child.send({ keyHex, userId });

  // Wait briefly for child to acknowledge, then output eval commands
  child.on("message", () => {
    console.log(`PSSO_AGENT_SOCK='${socketPath}'; export PSSO_AGENT_SOCK;`);
    console.log(`PSSO_AGENT_PID='${child.pid}'; export PSSO_AGENT_PID;`);
    console.log(`trap 'kill ${child.pid} 2>/dev/null; rm -f ${socketPath}' EXIT;`);

    child.unref();
    child.disconnect();
    process.exit(0);
  });

  // If child exits before acknowledging, report error
  child.on("exit", (code) => {
    process.stderr.write(`Agent child exited unexpectedly with code ${code}\n`);
    process.exit(1);
  });

  // Timeout if child doesn't respond
  setTimeout(() => {
    process.stderr.write("Error: Agent child did not respond within 10s.\n");
    child.kill();
    process.exit(1);
  }, 10_000);
}

/**
 * Internal: runs as the daemon child process (forked by --eval).
 * Receives vault key via IPC from parent, then starts the agent.
 */
function runDaemonChild(): Promise<void> {
  return new Promise((resolve) => {
    process.on("message", async (msg: { keyHex: string; userId: string | null }) => {
      try {
        // Import vault key from hex
        const { hexDecode } = await import("../lib/crypto.js");
        const rawBytes = hexDecode(msg.keyHex);
        const key = await crypto.subtle.importKey(
          "raw",
          new Uint8Array(rawBytes).buffer as ArrayBuffer,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
        setEncryptionKey(key, msg.userId ?? undefined);

        // Acknowledge to parent
        process.send!("ready");

        // Disconnect IPC (no longer needed)
        if (process.disconnect) process.disconnect();

        // Start agent in foreground (this process stays running)
        const socketPath = getDecryptSocketPath();
        startForegroundAgent(socketPath);
        resolve();
      } catch (err) {
        process.stderr.write(`Daemon init error: ${err}\n`);
        process.exit(1);
      }
    });
  });
}

/**
 * Start the agent in foreground mode (used by both direct and daemon child).
 */
async function startForegroundAgent(socketPath: string): Promise<void> {
  startBackgroundRefresh();
  prepareSocket(socketPath);

  const server = createServer(handleConnection);

  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o600);
  });

  server.on("error", (err) => {
    process.stderr.write(`Agent socket error: ${err.message}\n`);
    process.exit(1);
  });

  // Clean up on process exit
  const cleanup = () => {
    server.close();
    try {
      unlinkSync(socketPath);
    } catch {
      // Already cleaned up
    }
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

  // Keep process running
  await new Promise<void>(() => {
    // Never resolves — process exits via signal handlers
  });
}
