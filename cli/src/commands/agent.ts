/**
 * `passwd-sso agent` — Start an SSH agent backed by vault SSH keys.
 *
 * Usage:
 *   eval $(passwd-sso agent --eval)   # fork a detached daemon, set SSH_AUTH_SOCK
 *   ssh-add -l                         # List vault SSH keys
 *   ssh -T git@github.com              # Use via agent
 *
 * Without --eval the agent runs in the foreground (Ctrl+C to stop). With
 * --eval it forks a detached child holding the vault key (mirrors the decrypt
 * agent) and the parent prints the export commands and exits, so command
 * substitution returns instead of blocking.
 */

import { spawn } from "node:child_process";
import { apiRequest } from "../lib/api-client.js";
import { decryptData, hexEncode } from "../lib/crypto.js";
import { buildPersonalEntryAAD, VAULT_TYPE } from "../lib/crypto-aad.js";
import {
  getEncryptionKey,
  getUserId,
  getSecretKeyBytes,
  setEncryptionKey,
  isUnlocked,
} from "../lib/vault-state.js";
import {
  autoUnlockIfNeeded,
  readPassphrase,
  unlockWithPassphrase,
} from "./unlock.js";
import { loadKey, clearKeys } from "../lib/ssh-key-agent.js";
import { startAgent, stopAgent, setAgentDeps } from "../lib/ssh-agent-socket.js";
import { authorizeSign } from "../lib/ssh-sign-authorizer.js";
import { confirmSign } from "../lib/ssh-confirm.js";
import { decryptAgentCommand } from "./agent-decrypt.js";
import * as output from "../lib/output.js";
import { AGENT_CHILD_TIMEOUT_MS, VAULT_LOCK_POLL_INTERVAL_MS } from "../lib/time.js";
import { CLI_API_PATH } from "../lib/api-paths.js";

/** Env flag marking the forked daemon child process. */
const SSH_DAEMON_ENV = "_PSSO_SSH_DAEMON";

interface VaultEntry {
  id: string;
  entryType: string;
  encryptedBlob: {
    ciphertext: string;
    iv: string;
    authTag: string;
  };
  aadVersion: number;
  /** Whether each signature requires explicit user confirmation */
  requireReprompt?: boolean;
}

interface SshKeyBlob {
  title?: string;
  privateKey?: string;
  publicKey?: string;
  keyType?: string;
  fingerprint?: string;
  comment?: string;
  passphrase?: string;
}

export interface AgentOptions {
  eval?: boolean;
  decrypt?: boolean;
}

/**
 * Build an SSH public key blob from the stored public key string.
 * The public key is in OpenSSH format: "ssh-ed25519 AAAA... comment"
 */
function parsePublicKeyBlob(publicKeyStr: string): Buffer | null {
  const parts = publicKeyStr.trim().split(/\s+/);
  if (parts.length < 2) return null;

  try {
    return Buffer.from(parts[1], "base64");
  } catch {
    return null;
  }
}

/**
 * Fetch every SSH_KEY entry, decrypt it, and load it into the in-memory
 * agent. Returns the number of keys loaded. Exits the process on a fatal
 * condition (no encryption key, fetch failure, no keys, none loadable).
 */
async function loadSshKeys(): Promise<number> {
  const encryptionKey = getEncryptionKey();
  if (!encryptionKey) {
    output.error("Encryption key not available.");
    process.exit(1);
  }

  const userId = getUserId();

  const res = await apiRequest<VaultEntry[]>(`${CLI_API_PATH.PASSWORDS}?type=SSH_KEY&include=blob`);
  if (!res.ok) {
    output.error(`Failed to fetch SSH keys: HTTP ${res.status}`);
    process.exit(1);
  }
  if (res.data.length === 0) {
    output.error("No SSH keys found in vault.");
    process.exit(1);
  }

  let loadedCount = 0;
  for (const entry of res.data) {
    try {
      const aad = entry.aadVersion >= 1 && userId
        ? buildPersonalEntryAAD(userId, entry.id, VAULT_TYPE.BLOB)
        : undefined;
      const plaintext = await decryptData(entry.encryptedBlob, encryptionKey, aad);
      const blob: SshKeyBlob = JSON.parse(plaintext);

      if (!blob.privateKey || !blob.publicKey) continue;

      const publicKeyBlob = parsePublicKeyBlob(blob.publicKey);
      if (!publicKeyBlob) continue;

      await loadKey(
        entry.id,
        blob.privateKey,
        publicKeyBlob,
        blob.comment ?? blob.title ?? "",
        blob.passphrase,
        entry.requireReprompt,
      );
      loadedCount++;
    } catch (err) {
      output.warn(
        `Failed to load SSH key ${entry.id}: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
  }

  if (loadedCount === 0) {
    output.error("No valid SSH keys could be loaded.");
    process.exit(1);
  }

  return loadedCount;
}

export async function agentCommand(opts: AgentOptions): Promise<void> {
  if (opts.decrypt) {
    return decryptAgentCommand({ eval: opts.eval });
  }

  // Internal daemon child (forked by --eval): receives the vault key via IPC.
  if (process.env[SSH_DAEMON_ENV] === "1") {
    return runDaemonChild();
  }

  // Unlock the vault in this (parent / foreground) process.
  if (!(await autoUnlockIfNeeded())) {
    if (opts.eval && process.stdin.isTTY) {
      // Prompt on stderr so stdout stays clean for `eval $(...)` capture.
      const passphrase = await readPassphrase("Master passphrase: ", { useStderr: true });
      if (!passphrase || !(await unlockWithPassphrase(passphrase))) {
        output.error("Vault unlock failed.");
        process.exit(1);
      }
    } else {
      output.error("Vault is locked. Run `passwd-sso unlock` first, or set PSSO_PASSPHRASE.");
      process.exit(1);
    }
  }

  if (opts.eval) {
    return forkDaemon();
  }

  // Foreground mode: load keys and serve in this process.
  const loadedCount = await loadSshKeys();
  setAgentDeps({ authorizeSign, confirmSign });
  const socketPath = startAgent();

  output.success(`SSH agent started with ${loadedCount} key(s).`);
  output.info(`Socket: ${socketPath}`);
  output.info("Set SSH_AUTH_SOCK:");
  console.log(`  export SSH_AUTH_SOCK=${socketPath}`);
  output.info("Or use:");
  console.log(`  eval $(passwd-sso agent --eval)`);
  output.info("Press Ctrl+C to stop the agent.");

  // Handle vault lock → clear keys
  const checkLock = setInterval(() => {
    if (!isUnlocked()) {
      output.warn("Vault locked — clearing agent keys.");
      clearKeys();
      stopAgent();
      clearInterval(checkLock);
      process.exit(0);
    }
  }, VAULT_LOCK_POLL_INTERVAL_MS);

  // Wait forever (signal handlers in ssh-agent-socket.ts handle cleanup)
  await new Promise<void>(() => {
    // Never resolves — process exits via signal handlers
  });
}

/**
 * --eval mode: fork a detached child holding the vault key, print the
 * SSH_AUTH_SOCK export commands, and exit so `eval $(...)` returns. Mirrors
 * the decrypt agent's forkDaemon (agent-decrypt.ts).
 */
async function forkDaemon(): Promise<void> {
  const secretBytes = getSecretKeyBytes();
  if (!secretBytes) {
    output.error("Secret key bytes not available.");
    process.exit(1);
  }

  // Send the raw secret bytes (not the derived CryptoKey) — the child derives
  // the encryption key itself. Zero the source array after hex-encoding.
  const secretHex = hexEncode(secretBytes);
  secretBytes.fill(0);
  const userId = getUserId();

  // Reconstruct args for the child: drop --eval, preserve tsx loader flags.
  const childArgs = [
    ...process.execArgv.filter((a) => !a.startsWith("--eval")),
    ...process.argv.slice(1).filter((a) => a !== "--eval"),
  ];

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: { ...process.env, [SSH_DAEMON_ENV]: "1" },
  });

  child.send({ secretHex, userId });

  // Child reports the socket path once it is serving keys.
  child.on("message", (msg: { socketPath: string }) => {
    console.log(`SSH_AUTH_SOCK='${msg.socketPath}'; export SSH_AUTH_SOCK;`);
    console.log(`SSH_AGENT_PID='${child.pid}'; export SSH_AGENT_PID;`);
    console.log(`trap 'kill ${child.pid} 2>/dev/null; rm -f ${msg.socketPath}' EXIT;`);

    child.unref();
    child.disconnect();
    process.exit(0);
  });

  // Child exited before acknowledging (e.g., no loadable keys) → surface it.
  child.on("exit", (code) => {
    process.stderr.write(`Agent child exited unexpectedly with code ${code}\n`);
    process.exit(1);
  });

  setTimeout(() => {
    process.stderr.write("Error: Agent child did not respond within 10s.\n");
    child.kill();
    process.exit(1);
  }, AGENT_CHILD_TIMEOUT_MS);
}

/**
 * Internal daemon child: receives the vault secret via IPC, derives the
 * encryption key, loads the SSH keys, starts the socket, and reports the
 * socket path back to the parent. The listening socket keeps the process
 * alive after the IPC channel is disconnected.
 */
function runDaemonChild(): Promise<void> {
  return new Promise((resolve) => {
    process.on("message", async (msg: { secretHex: string; userId: string | null }) => {
      try {
        const { hexDecode, deriveEncryptionKey } = await import("../lib/crypto.js");
        const secretBytes = hexDecode(msg.secretHex);
        const key = await deriveEncryptionKey(secretBytes);
        secretBytes.fill(0);
        setEncryptionKey(key, msg.userId ?? undefined);

        await loadSshKeys(); // exits(1) on no loadable keys → parent reports via "exit"
        setAgentDeps({ authorizeSign, confirmSign });
        const socketPath = startAgent();

        process.send!({ socketPath });
        if (process.disconnect) process.disconnect();
        resolve();
      } catch (err) {
        process.stderr.write(
          `Daemon init error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });
  });
}
