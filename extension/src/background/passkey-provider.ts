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

const WEBAUTHN_TYPE_GET = "webauthn.get";
const WEBAUTHN_TYPE_CREATE = "webauthn.create";

function validateClientDataJSON(
  raw: string,
  expectedType: string,
): boolean {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.type === expectedType
      && typeof parsed.challenge === "string"
      && parsed.challenge.length > 0;
  } catch {
    return false;
  }
}

// Per-credential signing mutex to prevent counter collision from concurrent assertions.
const signingLocks = new Map<string, Promise<unknown>>();

async function withSigningLock<T>(entryId: string, fn: () => Promise<T>): Promise<T> {
  const prev = signingLocks.get(entryId) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
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
        ...(e.creationDate && { creationDate: e.creationDate }),
        ...(e.teamId && { teamId: e.teamId }),
      }));
    return { entries: matches, vaultLocked: false };
  } catch {
    return { entries: [], vaultLocked: false };
  }
}

// ── PASSKEY_CHECK_DUPLICATE ──

export async function handlePasskeyCheckDuplicate(
  rpId: string,
  userName: string,
): Promise<{ entries: PasskeyMatchEntry[] }> {
  if (!deps) return { entries: [] };
  const encKey = deps.getEncryptionKey();
  if (!encKey) return { entries: [] };

  try {
    const allEntries = await deps.getCachedEntries();
    const entries = allEntries
      .filter(
        (e) =>
          e.entryType === EXT_ENTRY_TYPE.PASSKEY &&
          e.relyingPartyId === rpId &&
          e.username === userName &&
          e.credentialId,
      )
      .map((e) => ({
        id: e.id,
        title: e.title,
        username: e.username,
        relyingPartyId: e.relyingPartyId!,
        credentialId: e.credentialId!,
        ...(e.creationDate && { creationDate: e.creationDate }),
      }));
    return { entries };
  } catch {
    return { entries: [] };
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

  if (!validateClientDataJSON(clientDataJSON, WEBAUTHN_TYPE_GET)) {
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
    const userHandle = blob.passkeyUserHandle as string | null;
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
  replaceEntryId?: string;
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
    clientDataJSON,
  } = params;

  if (!validateClientDataJSON(clientDataJSON, WEBAUTHN_TYPE_CREATE)) {
    return { ok: false, error: "INVALID_CLIENT_DATA" };
  }

  try {
    const { privateKeyJwk, publicKeyCose, publicKeyDer } = await generatePasskeyKeypair();
    const credentialIdBytes = generateCredentialId();
    const credentialIdB64 = base64urlEncode(credentialIdBytes);

    const authData = await buildAttestationAuthData(
      rpId,
      0,
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
      passkeySignCount: 0,
      passkeyAlgorithm: -7,
      passkeyTransports: ["internal", "hybrid"],
      tags: [],
    });

    const overviewBlob = JSON.stringify({
      title,
      relyingPartyId: rpId,
      credentialId: credentialIdB64,
      username: userName,
      creationDate: new Date().toISOString(),
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

    // Delete old entry after successful creation (best-effort, non-fatal)
    if (params.replaceEntryId) {
      await deps.swFetch(extApiPath.passwordById(params.replaceEntryId), {
        method: "DELETE",
      }).catch(() => {});
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
        authData: base64urlEncode(authData),
        publicKeyDer: base64urlEncode(publicKeyDer),
        transports: ["internal", "hybrid"],
      },
    };
  } catch (err) {
    return { ok: false, error: normalizeErrorCode(err, "CREATE_FAILED") };
  }
}
