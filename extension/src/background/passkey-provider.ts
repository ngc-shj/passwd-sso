// Background handler for passkey provider operations.
// Handles key generation, signing, and entry CRUD for PASSKEY entries.
// Follows the same dependency-injection pattern as login-save.ts.

import type { EncryptedData } from "../lib/crypto";
import {
  encryptData,
  decryptData,
  buildPersonalEntryAAD,
} from "../lib/crypto";
import { EXT_API_PATH, extApiPath } from "../lib/api-paths";
import { normalizeErrorCode } from "../lib/error-utils";
import { EXT_ENTRY_TYPE } from "../lib/constants";
import type {
  DecryptedEntry,
  PasskeyMatchEntry,
  SerializedAssertionResponse,
  SerializedAttestationResponse,
} from "../types/messages";
import {
  generatePasskeyKeypair,
  generateCredentialId,
  buildAssertionAuthData,
  buildAttestationAuthData,
  buildAttestationObject,
  signAssertion,
  base64urlEncode,
} from "../lib/webauthn-crypto";

// ── Dependencies injected from background/index.ts ──────────

export interface PasskeyProviderDeps {
  getEncryptionKey: () => CryptoKey | null;
  getCurrentUserId: () => string | null;
  getCachedEntries: () => Promise<DecryptedEntry[]>;
  swFetch: (path: string, init?: RequestInit) => Promise<Response>;
  invalidateCache: () => void;
}

let deps: PasskeyProviderDeps | null = null;

export function initPasskeyProvider(d: PasskeyProviderDeps): void {
  deps = d;
}

// Per-credential signing mutex to prevent counter collision from concurrent assertions.
const signingLocks = new Map<string, Promise<unknown>>();

async function withSigningLock<T>(entryId: string, fn: () => Promise<T>): Promise<T> {
  const prev = signingLocks.get(entryId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  signingLocks.set(entryId, next);
  try {
    return await next;
  } finally {
    if (signingLocks.get(entryId) === next) signingLocks.delete(entryId);
  }
}

// ── PASSKEY_GET_MATCHES ──

export async function handlePasskeyGetMatches(
  rpId: string,
): Promise<{
  entries: PasskeyMatchEntry[];
  vaultLocked: boolean;
}> {
  if (!deps) return { entries: [], vaultLocked: true };

  const encKey = deps.getEncryptionKey();
  if (!encKey || !deps.getCurrentUserId()) {
    return { entries: [], vaultLocked: true };
  }

  try {
    const allEntries = await deps.getCachedEntries();
    const matches = allEntries
      .filter(
        (e) =>
          e.entryType === EXT_ENTRY_TYPE.PASSKEY &&
          e.relyingPartyId === rpId &&
          e.credentialId,
      )
      .map((e) => ({
        id: e.id,
        title: e.title,
        username: e.username,
        relyingPartyId: e.relyingPartyId!,
        credentialId: e.credentialId!,
        ...(e.teamId && { teamId: e.teamId }),
      }));
    return { entries: matches, vaultLocked: false };
  } catch {
    return { entries: [], vaultLocked: false };
  }
}

// ── PASSKEY_SIGN_ASSERTION ──

export function handlePasskeySignAssertion(
  entryId: string,
  clientDataJSON: string,
  teamId?: string,
): Promise<{
  ok: boolean;
  response?: SerializedAssertionResponse;
  error?: string;
}> {
  return withSigningLock(entryId, () => doSignAssertion(entryId, clientDataJSON, teamId));
}

async function doSignAssertion(
  entryId: string,
  clientDataJSON: string,
  teamId?: string,
): Promise<{
  ok: boolean;
  response?: SerializedAssertionResponse;
  error?: string;
}> {
  if (!deps) return { ok: false, error: "NOT_INITIALIZED" };

  const encKey = deps.getEncryptionKey();
  const userId = deps.getCurrentUserId();
  if (!encKey || !userId) {
    return { ok: false, error: "VAULT_LOCKED" };
  }

  // Validate clientDataJSON structure (constructed in untrusted MAIN world)
  try {
    const parsed = JSON.parse(clientDataJSON) as Record<string, unknown>;
    if (parsed.type !== "webauthn.get" || typeof parsed.challenge !== "string") {
      return { ok: false, error: "INVALID_CLIENT_DATA" };
    }
  } catch {
    return { ok: false, error: "INVALID_CLIENT_DATA" };
  }

  if (teamId) {
    return { ok: false, error: "TEAM_PASSKEY_NOT_SUPPORTED" };
  }

  try {
    const path = extApiPath.passwordById(entryId);
    const res = await deps.swFetch(path);
    if (!res.ok) return { ok: false, error: "FETCH_FAILED" };

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

    const blobPlain = await decryptData(data.encryptedBlob, encKey, aad);
    const blob = JSON.parse(blobPlain) as Record<string, unknown>;

    const privateKeyJwkStr = blob.passkeyPrivateKeyJwk as string | null;
    const credentialIdStr = blob.credentialId as string | null;
    const rpId = blob.relyingPartyId as string | null;
    const userHandle = (blob.passkeyUserHandle as string | null) ?? null;
    let signCount = (blob.passkeySignCount as number | null) ?? 0;

    if (!privateKeyJwkStr || !credentialIdStr || !rpId) {
      return { ok: false, error: "MISSING_KEY_MATERIAL" };
    }

    const privateKeyJwk = JSON.parse(privateKeyJwkStr) as JsonWebKey;
    signCount += 1;

    const authenticatorData = await buildAssertionAuthData(rpId, signCount);
    const signature = await signAssertion(
      privateKeyJwk,
      authenticatorData,
      clientDataJSON,
    );

    // Update counter in blob and persist (overview unchanged, omit from PUT)
    blob.passkeySignCount = signCount;
    const encryptedBlob = await encryptData(
      JSON.stringify(blob),
      encKey,
      aad,
    );

    const putRes = await deps.swFetch(path, {
      method: "PUT",
      body: JSON.stringify({
        encryptedBlob,
        aadVersion: data.aadVersion ?? 1,
        keyVersion: 1,
      }),
    });

    if (!putRes.ok) {
      // Assertion still succeeds even if counter update fails
    }

    return {
      ok: true,
      response: {
        credentialId: credentialIdStr,
        authenticatorData: base64urlEncode(authenticatorData),
        signature: base64urlEncode(signature),
        userHandle,
        clientDataJSON: base64urlEncode(
          new TextEncoder().encode(clientDataJSON),
        ),
      },
    };
  } catch (err) {
    return { ok: false, error: normalizeErrorCode(err, "SIGN_FAILED") };
  }
}

// ── PASSKEY_CREATE_CREDENTIAL ──

export interface CreateCredentialParams {
  rpId: string;
  rpName: string;
  userId: string;
  userName: string;
  userDisplayName: string;
  excludeCredentialIds: string[];
  clientDataJSON: string;
}

export async function handlePasskeyCreateCredential(
  params: CreateCredentialParams,
): Promise<{
  ok: boolean;
  response?: SerializedAttestationResponse;
  error?: string;
}> {
  if (!deps) return { ok: false, error: "NOT_INITIALIZED" };

  const encKey = deps.getEncryptionKey();
  const currentUserId = deps.getCurrentUserId();
  if (!encKey || !currentUserId) {
    return { ok: false, error: "VAULT_LOCKED" };
  }

  const {
    rpId, rpName, userId, userName, userDisplayName,
    excludeCredentialIds, clientDataJSON,
  } = params;

  // Validate clientDataJSON structure (constructed in untrusted MAIN world)
  try {
    const parsed = JSON.parse(clientDataJSON) as Record<string, unknown>;
    if (parsed.type !== "webauthn.create" || typeof parsed.challenge !== "string") {
      return { ok: false, error: "INVALID_CLIENT_DATA" };
    }
  } catch {
    return { ok: false, error: "INVALID_CLIENT_DATA" };
  }

  try {
    const entries = await deps.getCachedEntries();
    const isDuplicate = entries.some(
      (e) =>
        e.entryType === EXT_ENTRY_TYPE.PASSKEY &&
        e.relyingPartyId === rpId &&
        e.credentialId &&
        excludeCredentialIds.includes(e.credentialId),
    );
    if (isDuplicate) {
      return { ok: false, error: "CREDENTIAL_EXCLUDED" };
    }

    const { privateKeyJwk, publicKeyCose } = await generatePasskeyKeypair();
    const credentialIdBytes = generateCredentialId();
    const credentialIdB64 = base64urlEncode(credentialIdBytes);

    const signCount = 0;

    const authData = await buildAttestationAuthData(
      rpId,
      signCount,
      credentialIdBytes,
      publicKeyCose,
    );
    const attestationObject = buildAttestationObject(authData);

    const entryId = crypto.randomUUID();
    const aad = buildPersonalEntryAAD(currentUserId, entryId);
    const title = `${rpName} (${userName})`;

    const fullBlob = JSON.stringify({
      entryType: EXT_ENTRY_TYPE.PASSKEY,
      title,
      username: userName,
      relyingPartyId: rpId,
      relyingPartyName: rpName,
      credentialId: credentialIdB64,
      creationDate: new Date().toISOString(),
      passkeyPrivateKeyJwk: JSON.stringify(privateKeyJwk),
      passkeyPublicKeyCose: base64urlEncode(publicKeyCose),
      passkeyUserHandle: userId,
      passkeyUserDisplayName: userDisplayName,
      passkeySignCount: signCount,
      passkeyAlgorithm: -7,
      passkeyTransports: ["internal", "hybrid"],
      tags: [],
    });

    const overviewBlob = JSON.stringify({
      title,
      relyingPartyId: rpId,
      credentialId: credentialIdB64,
      username: userName,
      tags: [],
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
        entryType: EXT_ENTRY_TYPE.PASSKEY,
      }),
    });

    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      return {
        ok: false,
        error: (json as { error?: string }).error ?? "SAVE_FAILED",
      };
    }

    deps.invalidateCache();

    return {
      ok: true,
      response: {
        credentialId: credentialIdB64,
        attestationObject: base64urlEncode(attestationObject),
        clientDataJSON: base64urlEncode(
          new TextEncoder().encode(clientDataJSON),
        ),
        transports: ["internal", "hybrid"],
      },
    };
  } catch (err) {
    return { ok: false, error: normalizeErrorCode(err, "CREATE_FAILED") };
  }
}
