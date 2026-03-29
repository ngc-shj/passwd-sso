/**
 * `passwd-sso unlock` — Unlock the vault with passphrase.
 *
 * Derives the encryption key and stores it in process memory.
 */

import { apiRequest } from "../lib/api-client.js";
import {
  hexDecode,
  deriveWrappingKey,
  unwrapSecretKey,
  deriveEncryptionKey,
  verifyKey,
} from "../lib/crypto.js";
import { setEncryptionKey, isUnlocked } from "../lib/vault-state.js";
import * as output from "../lib/output.js";
import type { EncryptedData } from "../lib/crypto.js";

interface UnlockData {
  userId: string;
  encryptedSecretKey: string;
  secretKeyIv: string;
  secretKeyAuthTag: string;
  verificationArtifact: {
    ciphertext: string;
    iv: string;
    authTag: string;
  } | null;
  accountSalt: string;
}

export async function readPassphrase(prompt: string): Promise<string> {
  process.stdout.write(prompt);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(true);
  }
  process.stdin.resume();

  return new Promise((resolve) => {
    let passphrase = "";

    const onData = (key: Buffer) => {
      const char = key.toString("utf-8");
      if (char === "\n" || char === "\r" || char === "\u0003") {
        process.stdin.removeListener("data", onData);
        process.stdin.removeListener("end", onEnd);
        if (process.stdin.isTTY) {
          process.stdin.setRawMode?.(false);
        }
        process.stdin.pause();
        console.log(); // newline after hidden input
        if (char === "\u0003") {
          process.exit(130);
        }
        resolve(passphrase);
      } else if (char === "\u007F" || char === "\b") {
        passphrase = passphrase.slice(0, -1);
      } else {
        passphrase += char;
      }
    };

    const onEnd = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode?.(false);
      }
      process.stdin.pause();
      console.log();
      resolve(passphrase);
    };

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}

/**
 * Core unlock logic — derives encryption key from passphrase and stores it.
 * Returns true on success, false on failure.
 */
export async function unlockWithPassphrase(passphrase: string): Promise<boolean> {
  const res = await apiRequest<UnlockData>("/api/vault/unlock/data");
  if (!res.ok) {
    output.error(`Failed to fetch vault data: ${res.status}`);
    return false;
  }

  const data = res.data;
  if (!data.accountSalt || !data.encryptedSecretKey) {
    output.error("Vault is not set up. Please set up your vault in the web UI first.");
    return false;
  }

  try {
    const accountSalt = hexDecode(data.accountSalt);
    const wrappingKey = await deriveWrappingKey(passphrase, accountSalt);

    const encryptedSecret: EncryptedData = {
      ciphertext: data.encryptedSecretKey,
      iv: data.secretKeyIv,
      authTag: data.secretKeyAuthTag,
    };

    const secretKey = await unwrapSecretKey(encryptedSecret, wrappingKey);
    const encryptionKey = await deriveEncryptionKey(secretKey);

    if (data.verificationArtifact) {
      const valid = await verifyKey(encryptionKey, data.verificationArtifact);
      if (!valid) {
        output.error("Incorrect passphrase.");
        return false;
      }
    }

    setEncryptionKey(encryptionKey, data.userId);
    return true;
  } catch {
    output.error("Failed to unlock vault. Check your passphrase.");
    return false;
  }
}

export async function unlockCommand(): Promise<void> {
  if (isUnlocked()) {
    output.info("Vault is already unlocked.");
    return;
  }

  const passphrase = await readPassphrase("Master passphrase: ");
  if (!passphrase) {
    output.error("Passphrase is required.");
    return;
  }

  if (await unlockWithPassphrase(passphrase)) {
    output.success("Vault unlocked.");
  }
}

/**
 * Auto-unlock using PSSO_PASSPHRASE env var if vault is locked.
 * Returns true if vault is unlocked (already or just now), false otherwise.
 */
export async function autoUnlockIfNeeded(): Promise<boolean> {
  if (isUnlocked()) return true;

  const passphrase = process.env.PSSO_PASSPHRASE;
  if (!passphrase) {
    return false;
  }

  return unlockWithPassphrase(passphrase);
}
