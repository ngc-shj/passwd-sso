// Background handler for saving/updating login credentials.
// Separated from index.ts to avoid further bloating the main background module.

import type { EncryptedData } from "../lib/crypto";
import {
  encryptData,
  decryptData,
  buildPersonalEntryAAD,
  VAULT_TYPE,
} from "../lib/crypto";
import { EXT_API_PATH, extApiPath } from "../lib/api-paths";
import { readApiErrorBody } from "../lib/api-error-body";
import { normalizeErrorCode } from "../lib/error-utils";
import { EXT_ENTRY_TYPE } from "../lib/constants";
import type { DecryptedEntry } from "../types/messages";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Dependencies injected from background/index.ts ──────────

export interface LoginSaveDeps {
  getEncryptionKey: () => CryptoKey | null;
  getCurrentUserId: () => string | null;
  getKeyVersion: () => number;
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
      (e) => e.entryType === EXT_ENTRY_TYPE.LOGIN && (
        (e.urlHost && deps!.isHostMatch(e.urlHost, host)) ||
        (e.additionalUrlHosts ?? []).some((h) => deps!.isHostMatch(h, host))
      ),
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
        ? buildPersonalEntryAAD(userId, data.id, VAULT_TYPE.BLOB)
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
    const blobAad = buildPersonalEntryAAD(userId, entryId, VAULT_TYPE.BLOB);
    const overviewAad = buildPersonalEntryAAD(userId, entryId, VAULT_TYPE.OVERVIEW);

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

    const encryptedBlob = await encryptData(fullBlob, encKey, blobAad);
    const encryptedOverview = await encryptData(overviewBlob, encKey, overviewAad);

    const res = await deps.swFetch(EXT_API_PATH.PASSWORDS, {
      method: "POST",
      body: JSON.stringify({
        id: entryId,
        encryptedBlob,
        encryptedOverview,
        aadVersion: 1,
        keyVersion: deps.getKeyVersion(),
        entryType: EXT_ENTRY_TYPE.LOGIN,
      }),
    });

    if (!res.ok) {
      const body = await readApiErrorBody(res);
      return { ok: false, error: body?.error ?? "SAVE_FAILED" };
    }

    deps.invalidateCache();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: normalizeErrorCode(err, "SAVE_FAILED") };
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

    // Per-field AADs: blob and overview must never share an AAD (cross-field
    // replay protection — matches the app's BLOB/OVERVIEW split).
    // `?? 1` promotes a null/absent aadVersion to 1; an explicit 0 stays 0
    // (no-AAD legacy path) — `??` does not fire on 0.
    const useAad = (data.aadVersion ?? 0) >= 1;
    const blobAad = useAad
      ? buildPersonalEntryAAD(userId, data.id, VAULT_TYPE.BLOB)
      : undefined;
    const overviewAad = useAad
      ? buildPersonalEntryAAD(userId, data.id, VAULT_TYPE.OVERVIEW)
      : undefined;

    // Decrypt full blob, update password, re-encrypt
    const blobPlain = await decryptData(data.encryptedBlob, encKey, blobAad);
    const blob = JSON.parse(blobPlain) as Record<string, unknown>;
    blob.password = newPassword;

    // Re-encrypt both blobs (overview stays the same content but needs re-encryption)
    const overviewPlain = await decryptData(data.encryptedOverview, encKey, overviewAad);

    const encryptedBlob = await encryptData(JSON.stringify(blob), encKey, blobAad);
    const encryptedOverview = await encryptData(overviewPlain, encKey, overviewAad);

    const putRes = await deps.swFetch(extApiPath.passwordById(entryId), {
      method: "PUT",
      body: JSON.stringify({
        encryptedBlob,
        encryptedOverview,
        aadVersion: data.aadVersion ?? 1,
        keyVersion: deps.getKeyVersion(),
      }),
    });

    if (!putRes.ok) {
      const body = await readApiErrorBody(putRes);
      return { ok: false, error: body?.error ?? "UPDATE_FAILED" };
    }

    deps.invalidateCache();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: normalizeErrorCode(err, "UPDATE_FAILED") };
  }
}
