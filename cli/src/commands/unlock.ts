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

async function readPassphrase(prompt: string): Promise<string> {
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

export async function unlockCommand(): Promise<void> {
  if (isUnlocked()) {
    output.info("Vault is already unlocked.");
    return;
  }

  // Fetch unlock data
  const res = await apiRequest<UnlockData>("/api/vault/unlock/data");
  if (!res.ok) {
    output.error(`Failed to fetch vault data: ${res.status}`);
    return;
  }

  const data = res.data;
  if (!data.accountSalt || !data.encryptedSecretKey) {
    output.error("Vault is not set up. Please set up your vault in the web UI first.");
    return;
  }

  const passphrase = await readPassphrase("Master passphrase: ");
  if (!passphrase) {
    output.error("Passphrase is required.");
    return;
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

    // Verify with verification artifact
    if (data.verificationArtifact) {
      const valid = await verifyKey(encryptionKey, data.verificationArtifact);
      if (!valid) {
        output.error("Incorrect passphrase.");
        return;
      }
    }

    setEncryptionKey(encryptionKey, data.userId);
    output.success("Vault unlocked.");
  } catch {
    output.error("Failed to unlock vault. Check your passphrase.");
  }
}
