/**
 * `passwd-sso totp <id>` — Generate TOTP code for an entry.
 */

import { apiRequest } from "../lib/api-client.js";
import { getEncryptionKey, getUserId } from "../lib/vault-state.js";
import { decryptData } from "../lib/crypto.js";
import { buildPersonalEntryAAD } from "../lib/crypto-aad.js";
import { generateTOTPCode } from "../lib/totp.js";
import { copyToClipboard } from "../lib/clipboard.js";
import * as output from "../lib/output.js";

interface PasswordEntryDetail {
  id: string;
  encryptedBlob: {
    ciphertext: string;
    iv: string;
    authTag: string;
  };
  aadVersion: number;
}

interface EntryBlob {
  totp?: {
    secret: string;
    algorithm?: string;
    digits?: number;
    period?: number;
  };
}

export async function totpCommand(
  id: string,
  options: { copy?: boolean; json?: boolean },
): Promise<void> {
  const key = getEncryptionKey();
  if (!key) {
    output.error("Vault is locked. Run `unlock` first.");
    return;
  }

  const userId = getUserId();

  const res = await apiRequest<PasswordEntryDetail>(`/api/passwords/${id}`);
  if (!res.ok) {
    output.error(`Entry not found: ${res.status}`);
    return;
  }

  try {
    const aad = res.data.aadVersion >= 1 && userId
      ? buildPersonalEntryAAD(userId, res.data.id)
      : undefined;
    const plaintext = await decryptData(
      res.data.encryptedBlob,
      key,
      aad,
    );
    const blob: EntryBlob = JSON.parse(plaintext);

    if (!blob.totp?.secret) {
      output.error("No TOTP configured for this entry.");
      return;
    }

    const code = generateTOTPCode({
      secret: blob.totp.secret,
      algorithm: blob.totp.algorithm,
      digits: blob.totp.digits,
      period: blob.totp.period,
    });

    const period = blob.totp.period ?? 30;
    const remaining = period - (Math.floor(Date.now() / 1000) % period);

    if (options.json) {
      output.json({ code, remaining, period });
      return;
    }

    if (options.copy) {
      await copyToClipboard(code);
      output.success(`TOTP: ${code} (expires in ${remaining}s) — copied to clipboard`);
    } else {
      console.log(`${code}  (${remaining}s remaining)`);
    }
  } catch {
    output.error("Failed to generate TOTP code.");
  }
}
