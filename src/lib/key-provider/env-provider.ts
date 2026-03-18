/**
 * EnvKeyProvider — resolves keys from environment variables.
 *
 * Consolidates key loading logic from:
 *   - src/lib/crypto-server.ts (getMasterKeyByVersion, getVerifierPepper)
 *   - src/lib/directory-sync/credentials.ts (getDirectorySyncKey)
 *   - src/lib/webauthn-server.ts (getPrfSecret)
 */

import { createHash } from "node:crypto";
import type { KeyName, KeyProvider } from "./types";
import { HEX64_RE } from "./base-cloud-provider";

export class EnvKeyProvider implements KeyProvider {
  readonly name = "env";

  getKey(name: KeyName, version?: number): Promise<Buffer> {
    return Promise.resolve(this.getKeySync(name, version));
  }

  getKeySync(name: KeyName, version?: number): Buffer {
    switch (name) {
      case "share-master":
        return this.getShareMasterKey(version ?? 1);
      case "verifier-pepper":
        return this.getVerifierPepper();
      case "directory-sync":
        return this.getDirectorySyncKey();
      case "webauthn-prf":
        return this.getPrfSecret();
    }
  }

  async validateKeys(): Promise<void> {
    const raw = process.env.SHARE_MASTER_KEY_CURRENT_VERSION;
    const version = raw ? parseInt(raw, 10) : 1;
    if (!Number.isFinite(version) || version < 1) {
      throw new Error("SHARE_MASTER_KEY_CURRENT_VERSION must be a positive integer");
    }
    // Always validate the share master key (required in all environments)
    this.getShareMasterKey(version);

    // Validate optional keys only when their env vars are configured.
    // Production enforcement for missing keys happens at call time in each getter,
    // not here — this avoids blocking startup when only a subset of features is used.
    if (process.env.VERIFIER_PEPPER_KEY) this.getVerifierPepper();
    if (process.env.DIRECTORY_SYNC_MASTER_KEY) this.getDirectorySyncKey();
    if (process.env.WEBAUTHN_PRF_SECRET) this.getPrfSecret();
  }

  private getShareMasterKey(version: number): Buffer {
    if (!Number.isInteger(version) || version < 1 || version > 100) {
      throw new Error(`Invalid master key version: ${version} (must be integer 1-100)`);
    }

    let hex: string | undefined;
    if (version === 1) {
      // Use || so empty string falls through to the backup var
      hex = (process.env.SHARE_MASTER_KEY_V1?.trim() || process.env.SHARE_MASTER_KEY?.trim());
    } else {
      hex = process.env[`SHARE_MASTER_KEY_V${version}`]?.trim();
    }

    if (!hex || !HEX64_RE.test(hex)) {
      throw new Error(
        `Master key for version ${version} not found or invalid (expected 64-char hex)`
      );
    }
    return Buffer.from(hex, "hex");
  }

  private getVerifierPepper(): Buffer {
    const pepperHex = process.env.VERIFIER_PEPPER_KEY?.trim();
    if (pepperHex) {
      if (!HEX64_RE.test(pepperHex)) {
        throw new Error("VERIFIER_PEPPER_KEY must be a 64-char hex string (256 bits)");
      }
      return Buffer.from(pepperHex, "hex");
    }

    if (process.env.NODE_ENV === "production") {
      throw new Error("VERIFIER_PEPPER_KEY is required in production");
    }

    // Dev/test fallback: domain-separated derivation from master key V1
    return createHash("sha256")
      .update("verifier-pepper:")
      .update(this.getShareMasterKey(1))
      .digest();
  }

  private getDirectorySyncKey(): Buffer {
    const hex = process.env.DIRECTORY_SYNC_MASTER_KEY?.trim();
    if (hex && HEX64_RE.test(hex)) return Buffer.from(hex, "hex");

    if (process.env.NODE_ENV === "production") {
      throw new Error("DIRECTORY_SYNC_MASTER_KEY required in production");
    }

    // Dev/test fallback to share master V1 (use || so empty string falls through)
    const fallback = process.env.SHARE_MASTER_KEY_V1?.trim() || process.env.SHARE_MASTER_KEY?.trim();
    if (fallback && HEX64_RE.test(fallback)) return Buffer.from(fallback, "hex");

    throw new Error("No encryption key available for directory sync credentials");
  }

  private getPrfSecret(): Buffer {
    const hex = process.env.WEBAUTHN_PRF_SECRET?.trim();
    if (!hex || !HEX64_RE.test(hex)) {
      throw new Error(
        "WEBAUTHN_PRF_SECRET must be a 64-character hex string (32 bytes)"
      );
    }
    return Buffer.from(hex, "hex");
  }
}
