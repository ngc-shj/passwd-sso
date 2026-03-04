/**
 * `passwd-sso totp <id>` — Generate TOTP code for an entry.
 */

import { apiRequest } from "../lib/api-client.js";
import { getEncryptionKey } from "../lib/vault-state.js";
import { decryptData } from "../lib/crypto.js";
import { generateTOTPCode } from "../lib/totp.js";
import { copyToClipboard } from "../lib/clipboard.js";
import * as output from "../lib/output.js";

interface PasswordEntryDetail {
  id: string;
  encryptedBlob: string;
  blobIv: string;
  blobAuthTag: string;
}

interface EntryBlob {
  totp?: string;
  totpAlgorithm?: string;
  totpDigits?: number;
  totpPeriod?: number;
}

function buildAad(entryId: string): Uint8Array {
  return new TextEncoder().encode(`blob:${entryId}`);
}

export async function totpCommand(
  id: string,
  options: { copy?: boolean },
): Promise<void> {
  const key = getEncryptionKey();
  if (!key) {
    output.error("Vault is locked. Run `unlock` first.");
    return;
  }

  const res = await apiRequest<PasswordEntryDetail>(`/api/passwords/${id}`);
  if (!res.ok) {
    output.error(`Entry not found: ${res.status}`);
    return;
  }

  try {
    const plaintext = await decryptData(
      {
        ciphertext: res.data.encryptedBlob,
        iv: res.data.blobIv,
        authTag: res.data.blobAuthTag,
      },
      key,
      buildAad(res.data.id),
    );
    const blob: EntryBlob = JSON.parse(plaintext);

    if (!blob.totp) {
      output.error("No TOTP configured for this entry.");
      return;
    }

    const code = generateTOTPCode({
      secret: blob.totp,
      algorithm: blob.totpAlgorithm,
      digits: blob.totpDigits,
      period: blob.totpPeriod,
    });

    const period = blob.totpPeriod ?? 30;
    const remaining = period - (Math.floor(Date.now() / 1000) % period);

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
