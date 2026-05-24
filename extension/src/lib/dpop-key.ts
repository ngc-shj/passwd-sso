/**
 * DPoP key lifecycle for the browser extension background service worker.
 *
 * Manages an IDB-backed non-extractable EC P-256 signing key. The in-process
 * Promise singleton prevents generation races when multiple callers await
 * concurrently on a cold start.
 *
 * IDB schema: DB "psso-ext", store "dpop-keys", record key "current".
 * Record shape: { privateKey: CryptoKey, publicJwk: JsonWebKey }
 *
 * Persist-before-resolve ordering: IDB put() MUST complete before any caller
 * receives the thumbprint. If the SW is killed between generateKey() and
 * idbPut(), the next boot finds no IDB row and regenerates cleanly.
 */

// htu construction is inlined here (same algorithm as canonicalHtuClient).
// The extension build is a separate Vite/CRXJS bundle that cannot import
// from src/lib/auth/dpop/htu-canonical.ts — no shared tsconfig path mapping.

const IDB_NAME = "psso-ext";
const IDB_STORE = "dpop-keys";
const IDB_RECORD_KEY = "current";
const IDB_VERSION = 1;

interface DpopKeyRecord {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}

// In-process singleton Promise. Prevents concurrent generation on cold start.
let keyPromise: Promise<DpopKeyRecord> | null = null;

/** Open (or upgrade) the dpop-keys IDB. */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Read the persisted key record from IDB, or null if absent. */
async function idbGet(): Promise<DpopKeyRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(IDB_RECORD_KEY);
    req.onsuccess = () => {
      db.close();
      resolve((req.result as DpopKeyRecord) ?? null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

/** Persist a key record to IDB. Resolves only after the transaction commits. */
async function idbPut(record: DpopKeyRecord): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.objectStore(IDB_STORE).put(record, IDB_RECORD_KEY);
  });
}

/** Generate a new non-extractable EC P-256 key pair. */
async function generateKeyPair(): Promise<DpopKeyRecord> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    /* extractable */ false,
    ["sign"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return { privateKey: keyPair.privateKey, publicJwk };
}

/**
 * Compute RFC 7638 JWK thumbprint (base64url-encoded SHA-256 of the canonical
 * JSON representation of the public key's required members).
 */
async function computeThumbprint(publicJwk: JsonWebKey): Promise<string> {
  // Required members for EC keys per RFC 7638 §3.2, in lexicographic order.
  const canonical = JSON.stringify({
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x,
    y: publicJwk.y,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return base64url(new Uint8Array(digest));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Load the persisted key or generate + persist a new one.
 * All concurrent callers share the same Promise so IDB is written exactly once.
 */
function loadOrGenerate(): Promise<DpopKeyRecord> {
  if (keyPromise) return keyPromise;

  keyPromise = (async () => {
    const existing = await idbGet();
    if (existing) return existing;

    // Generate first, then persist. If IDB put fails, throw so the singleton
    // is cleared and the next caller retries.
    const record = await generateKeyPair();
    try {
      await idbPut(record);
    } catch (err) {
      // Clear singleton so next call retries from scratch.
      keyPromise = null;
      throw err;
    }
    return record;
  })();

  // On rejection, clear the singleton so callers can retry.
  keyPromise.catch(() => {
    keyPromise = null;
  });

  return keyPromise;
}

/**
 * Get (or lazily generate) the extension's DPoP key pair.
 *
 * Returns a stable object across repeated calls (same instance per IDB key).
 * The `sign` method wraps `crypto.subtle.sign` with ECDSA P-256 + SHA-256.
 */
export async function getOrGenerateDpopKeyPair(): Promise<{
  publicJwk: JsonWebKey;
  sign(data: ArrayBuffer): Promise<ArrayBuffer>;
}> {
  const record = await loadOrGenerate();
  return {
    publicJwk: record.publicJwk,
    sign: (data: ArrayBuffer) =>
      crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, record.privateKey, data),
  };
}

/** Return the RFC 7638 thumbprint of the current DPoP public key (43 base64url chars). */
export async function getDpopThumbprint(): Promise<string> {
  const record = await loadOrGenerate();
  return computeThumbprint(record.publicJwk);
}

/**
 * Build and sign a DPoP proof JWS (compact serialization).
 *
 * htu = origin + basePath + route (mirrors canonicalHtuClient on the server).
 */
export async function signDpopProof(input: {
  route: string;
  method: string;
  serverUrl: string;
  accessToken?: string;
}): Promise<string> {
  const record = await loadOrGenerate();
  const { publicJwk } = record;

  // Construct htu inline (same algorithm as canonicalHtuClient).
  const parsedUrl = new URL(input.serverUrl);
  const basePath = parsedUrl.pathname.replace(/\/$/, "");
  const htu = parsedUrl.origin + basePath + input.route;

  const thumbprint = await computeThumbprint(publicJwk);

  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: {
      kty: publicJwk.kty,
      crv: publicJwk.crv,
      x: publicJwk.x,
      y: publicJwk.y,
    },
  };

  const payload: Record<string, unknown> = {
    jti: crypto.randomUUID(),
    htm: input.method.toUpperCase(),
    htu,
    iat: Math.floor(Date.now() / 1000),
  };

  if (input.accessToken) {
    // ath = base64url(SHA-256(ASCII(access_token)))
    const ath = base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(input.accessToken),
        ),
      ),
    );
    payload.ath = ath;
  }

  const encodedHeader = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const encodedPayload = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    record.privateKey,
    new TextEncoder().encode(signingInput),
  );

  const encodedSig = base64url(new Uint8Array(signature));
  return `${signingInput}.${encodedSig}`;
}

/**
 * Drop the in-process key cache. Forces the next call to re-read IDB.
 * Used by swFetchAuthenticated on retry after a sign failure.
 */
export function resetInMemoryKeyCache(): void {
  keyPromise = null;
}

/**
 * Delete the persisted DPoP key from IDB and clear the in-process singleton.
 * Called from handleResetConnection in App.tsx so the next loadOrGenerate
 * regenerates a fresh key pair (new DPoP identity after key rotation).
 */
export async function deleteIdbKey(): Promise<void> {
  keyPromise = null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.objectStore(IDB_STORE).delete(IDB_RECORD_KEY);
  });
}
