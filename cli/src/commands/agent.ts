/**
 * `passwd-sso agent` — Start an SSH agent backed by vault SSH keys.
 *
 * Usage:
 *   eval $(passwd-sso agent --eval)   # Set SSH_AUTH_SOCK
 *   ssh-add -l                         # List vault SSH keys
 *   ssh -T git@github.com              # Use via agent
 */

import { apiRequest } from "../lib/api-client.js";
import { decryptData } from "../lib/crypto.js";
import { buildPersonalEntryAAD } from "../lib/crypto-aad.js";
import { getEncryptionKey, getUserId, isUnlocked } from "../lib/vault-state.js";
import { autoUnlockIfNeeded } from "./unlock.js";
import { loadKey, clearKeys } from "../lib/ssh-key-agent.js";
import { startAgent, stopAgent } from "../lib/ssh-agent-socket.js";
import * as output from "../lib/output.js";

interface VaultEntry {
  id: string;
  entryType: string;
  encryptedBlob: {
    ciphertext: string;
    iv: string;
    authTag: string;
  };
  aadVersion: number;
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

export async function agentCommand(opts: AgentOptions): Promise<void> {
  if (!await autoUnlockIfNeeded()) {
    output.error("Vault is locked. Run `passwd-sso unlock` first, or set PSSO_PASSPHRASE.");
    process.exit(1);
  }

  const encryptionKey = getEncryptionKey();
  if (!encryptionKey) {
    output.error("Encryption key not available.");
    process.exit(1);
  }

  const userId = getUserId();

  // Fetch all SSH_KEY entries from the vault
  const res = await apiRequest<VaultEntry[]>("/api/passwords?type=SSH_KEY&include=blob");
  if (!res.ok) {
    output.error(`Failed to fetch SSH keys: HTTP ${res.status}`);
    process.exit(1);
  }

  const entries = res.data;
  if (entries.length === 0) {
    output.error("No SSH keys found in vault.");
    process.exit(1);
  }

  // Decrypt and load each SSH key
  let loadedCount = 0;
  for (const entry of entries) {
    try {
      const aad = entry.aadVersion >= 1 && userId
        ? buildPersonalEntryAAD(userId, entry.id)
        : undefined;
      const plaintext = await decryptData(
        entry.encryptedBlob,
        encryptionKey,
        aad,
      );
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

  // Start the agent socket
  const socketPath = startAgent();

  if (opts.eval) {
    // Output shell commands to set SSH_AUTH_SOCK
    // The user runs: eval $(passwd-sso agent --eval)
    console.log(`SSH_AUTH_SOCK=${socketPath}; export SSH_AUTH_SOCK;`);
    console.log(`echo "Agent pid ${process.pid}";`);
  } else {
    output.success(`SSH agent started with ${loadedCount} key(s).`);
    output.info(`Socket: ${socketPath}`);
    output.info("Set SSH_AUTH_SOCK:");
    console.log(`  export SSH_AUTH_SOCK=${socketPath}`);
    output.info("Or use:");
    console.log(`  eval $(passwd-sso agent --eval)`);
  }

  // Keep process running until interrupted
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
  }, 5000);

  // Wait forever (signal handlers in ssh-agent-socket.ts handle cleanup)
  await new Promise<void>(() => {
    // Never resolves — process exits via signal handlers
  });
}
