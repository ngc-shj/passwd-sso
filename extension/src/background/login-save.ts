// Background handler for saving/updating login credentials.
// Separated from index.ts to avoid further bloating the main background module.

import type { EncryptedData } from "../lib/crypto";
import {
  encryptData,
  decryptData,
  buildPersonalEntryAAD,
} from "../lib/crypto";
import { EXT_API_PATH, extApiPath } from "../lib/api-paths";
import { EXT_ENTRY_TYPE } from "../lib/constants";
import type { DecryptedEntry } from "../types/messages";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Dependencies injected from background/index.ts ──────────

export interface LoginSaveDeps {
  getEncryptionKey: () => CryptoKey | null;
  getCurrentUserId: () => string | null;
  getCachedEntries: () => Promise<DecryptedEntry[]>;
  isHostMatch: (entryHost: string, tabHost: string) => boolean;
  extractHost: (url: string) => string | null;
  swFetch: (path: string, init?: RequestInit) => Promise<Response>;
  invalidateCache: () => void;
}

let deps: LoginSaveDeps | null = null;

export function initLoginSave(d: LoginSaveDeps): void {
  deps = d;
}

// ── LOGIN_DETECTED ──────────────────────────────────────────

export interface LoginDetectedResult {
  action: "save" | "update" | "none";
  existingEntryId?: string;
  existingTitle?: string;
}

export async function handleLoginDetected(
  url: string,
  username: string,
  password: string,
): Promise<LoginDetectedResult> {
  if (!deps) return { action: "none" };

  const encKey = deps.getEncryptionKey();
  const userId = deps.getCurrentUserId();
  if (!encKey || !userId) {
    // Vault locked — can't compare
    return { action: "none" };
  }

  const host = deps.extractHost(url);
  if (!host) return { action: "none" };

  try {
    const entries = await deps.getCachedEntries();
    // Find entries matching host + username
    const hostMatches = entries.filter(
      (e) => e.entryType === EXT_ENTRY_TYPE.LOGIN && deps!.isHostMatch(e.urlHost, host),
    );

    // Find entry with matching username (first match)
    const match = hostMatches.find(
      (e) => e.username.toLowerCase() === username.toLowerCase(),
    );

    if (!match) {
      return { action: "save" };
    }

    // Fetch full blob to compare password
    const res = await deps.swFetch(extApiPath.passwordById(match.id));
    if (!res.ok) return { action: "none" };

    const data = (await res.json()) as {
      encryptedBlob: EncryptedData;
      aadVersion?: number;
      id: string;
    };

    const aad =
      (data.aadVersion ?? 0) >= 1
        ? buildPersonalEntryAAD(userId, data.id)
        : undefined;

    const blobPlain = await decryptData(data.encryptedBlob, encKey, aad);
    const blob = JSON.parse(blobPlain) as { password?: string | null };

    if (blob.password === password) {
      // Same password — no action needed
      return { action: "none" };
    }

    // Different password — offer update
    return {
      action: "update",
      existingEntryId: match.id,
      existingTitle: match.title,
    };
  } catch {
    return { action: "none" };
  }
}

// ── SAVE_LOGIN ──────────────────────────────────────────────

export async function handleSaveLogin(
  url: string,
  title: string,
  username: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!deps) return { ok: false, error: "NOT_INITIALIZED" };

  const encKey = deps.getEncryptionKey();
  const userId = deps.getCurrentUserId();
  if (!encKey || !userId) {
    return { ok: false, error: "VAULT_LOCKED" };
  }

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, error: "INVALID_URL" };
  }

  try {
    const entryId = crypto.randomUUID();
    const aad = buildPersonalEntryAAD(userId, entryId);

    const fullBlob = JSON.stringify({
      title,
      username,
      password,
      url,
      notes: "",
    });
    const overviewBlob = JSON.stringify({
      title,
      username,
      urlHost: host,
    });

    const encryptedBlob = await encryptData(fullBlob, encKey, aad);
    const encryptedOverview = await encryptData(overviewBlob, encKey, aad);

    const res = await deps.swFetch(EXT_API_PATH.PASSWORDS, {
      method: "POST",
      body: JSON.stringify({
        id: entryId,
        encryptedBlob,
        encryptedOverview,
        aadVersion: 1,
        keyVersion: 1,
        entryType: EXT_ENTRY_TYPE.LOGIN,
      }),
    });

    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      return { ok: false, error: (json as { error?: string }).error ?? "SAVE_FAILED" };
    }

    deps.invalidateCache();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "SAVE_FAILED" };
  }
}

// ── UPDATE_LOGIN ────────────────────────────────────────────

export async function handleUpdateLogin(
  entryId: string,
  newPassword: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!deps) return { ok: false, error: "NOT_INITIALIZED" };

  if (!UUID_RE.test(entryId)) {
    return { ok: false, error: "INVALID_ENTRY_ID" };
  }

  const encKey = deps.getEncryptionKey();
  const userId = deps.getCurrentUserId();
  if (!encKey || !userId) {
    return { ok: false, error: "VAULT_LOCKED" };
  }

  try {
    // Fetch existing entry
    const res = await deps.swFetch(extApiPath.passwordById(entryId));
    if (!res.ok) {
      return { ok: false, error: "FETCH_FAILED" };
    }

    const data = (await res.json()) as {
      encryptedBlob: EncryptedData;
      encryptedOverview: EncryptedData;
      aadVersion?: number;
      id: string;
    };

    const aad =
      (data.aadVersion ?? 0) >= 1
        ? buildPersonalEntryAAD(userId, data.id)
        : undefined;

    // Decrypt full blob, update password, re-encrypt
    const blobPlain = await decryptData(data.encryptedBlob, encKey, aad);
    const blob = JSON.parse(blobPlain) as Record<string, unknown>;
    blob.password = newPassword;

    // Re-encrypt both blobs (overview stays the same content but needs re-encryption)
    const overviewPlain = await decryptData(data.encryptedOverview, encKey, aad);

    const encryptedBlob = await encryptData(JSON.stringify(blob), encKey, aad);
    const encryptedOverview = await encryptData(overviewPlain, encKey, aad);

    const putRes = await deps.swFetch(extApiPath.passwordById(entryId), {
      method: "PUT",
      body: JSON.stringify({
        encryptedBlob,
        encryptedOverview,
        aadVersion: data.aadVersion ?? 1,
        keyVersion: 1,
      }),
    });

    if (!putRes.ok) {
      const json = await putRes.json().catch(() => ({}));
      return { ok: false, error: (json as { error?: string }).error ?? "UPDATE_FAILED" };
    }

    deps.invalidateCache();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "UPDATE_FAILED" };
  }
}
