/**
 * Tests for extension/src/lib/dpop-key.ts — C6 acceptance criteria.
 *
 * Uses fake-indexeddb so IDB APIs are available in jsdom.
 * (vitest.config.ts maps **\/dpop-key.test.ts → jsdom environment)
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";

// Reset module state between tests so the in-process singleton is cleared.
// Each test gets a fresh import of the module.
async function importFresh() {
  // Force a fresh module load by importing with a cache-busting query.
  // Vitest does not support module cache clearing natively, so we use
  // the exported resetInMemoryKeyCache to approximate "SW restart".
  const mod = await import("../lib/dpop-key");
  return mod;
}

describe("dpop-key (C6)", () => {
  beforeEach(async () => {
    // Drop in-memory cache between tests (simulates SW restart).
    const mod = await import("../lib/dpop-key");
    mod.resetInMemoryKeyCache();
  });

  it("two sequential calls to getDpopThumbprint return the same thumbprint", async () => {
    const { getDpopThumbprint } = await importFresh();

    const jkt1 = await getDpopThumbprint();
    const jkt2 = await getDpopThumbprint();

    expect(jkt1).toBe(jkt2);
    expect(jkt1).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("concurrent Promise.all calls return the same thumbprint with exactly 1 IDB record", async () => {
    const { getDpopThumbprint } = await importFresh();

    // Both calls race; only one generation should happen.
    const [jkt1, jkt2] = await Promise.all([getDpopThumbprint(), getDpopThumbprint()]);

    expect(jkt1).toBe(jkt2);

    // Verify only one key was written to IDB.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("psso-ext");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const all = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction("dpop-keys", "readonly");
      const req = tx.objectStore("dpop-keys").getAll();
      req.onsuccess = () => resolve(req.result as unknown[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    expect(all).toHaveLength(1);
  });

  it("SW restart (drop cache, re-open IDB) returns the same thumbprint", async () => {
    const { getDpopThumbprint, resetInMemoryKeyCache } = await importFresh();

    const jkt1 = await getDpopThumbprint();
    resetInMemoryKeyCache(); // simulate SW restart: drop in-memory cache
    const jkt2 = await getDpopThumbprint(); // re-reads from IDB

    expect(jkt2).toBe(jkt1);
  });

  it("regenerates when IDB has no stored key (clean boot)", async () => {
    // After cache reset and IDB clear, a new key must be generated and persisted.
    // This covers the "regenerate on missing IDB row" path that also fires when
    // the SW was killed between generateKey() and idbPut() completing.
    const openFn = indexedDB.open.bind(indexedDB);
    const { getDpopThumbprint, resetInMemoryKeyCache } = await importFresh();
    resetInMemoryKeyCache();

    // Clear IDB to simulate clean-boot / partial-write after SW kill.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = openFn("psso-ext", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("dpop-keys", "readwrite");
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.objectStore("dpop-keys").clear();
    });

    const jktNew = await getDpopThumbprint();
    expect(jktNew).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Verify exactly one IDB row was written.
    const db2 = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = openFn("psso-ext");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const all = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db2.transaction("dpop-keys", "readonly");
      const req = tx.objectStore("dpop-keys").getAll();
      req.onsuccess = () => resolve(req.result as unknown[]);
      req.onerror = () => reject(req.error);
    });
    db2.close();
    expect(all).toHaveLength(1);
  });

  it("signDpopProof output is a valid 3-part JWS with expected claims", async () => {
    const { signDpopProof } = await importFresh();

    const proof = await signDpopProof({
      route: "/api/extension/token/exchange",
      method: "POST",
      serverUrl: "https://example.com",
    });

    const parts = proof.split(".");
    expect(parts).toHaveLength(3);

    const header = JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;

    // Header claims
    expect(header.typ).toBe("dpop+jwt");
    expect(header.alg).toBe("ES256");
    expect(header.jwk).toBeDefined();
    expect((header.jwk as Record<string, string>).kty).toBe("EC");

    // Payload claims
    expect(payload.htm).toBe("POST");
    expect(payload.htu).toBe("https://example.com/api/extension/token/exchange");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.jti).toBe("string");
    // No ath without accessToken
    expect(payload.ath).toBeUndefined();
  });

  it("signDpopProof includes ath claim when accessToken is provided", async () => {
    const { signDpopProof } = await importFresh();

    const proof = await signDpopProof({
      route: "/api/passwords",
      method: "GET",
      serverUrl: "https://example.com",
      accessToken: "some-bearer-token",
    });

    const parts = proof.split(".");
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    expect(typeof payload.ath).toBe("string");
    expect((payload.ath as string).length).toBeGreaterThan(0);
  });

  it("htu preserves basePath from serverUrl", async () => {
    const { signDpopProof } = await importFresh();

    const proof = await signDpopProof({
      route: "/api/passwords",
      method: "GET",
      serverUrl: "https://example.com/passwd-sso",
    });

    const parts = proof.split(".");
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    expect(payload.htu).toBe("https://example.com/passwd-sso/api/passwords");
  });

  it("private key is non-extractable", async () => {
    const { getOrGenerateDpopKeyPair } = await importFresh();

    // We cannot directly access the CryptoKey from the public API,
    // but we can verify that the sign() function works (proving the key exists)
    // and that a raw export of the key stored in IDB rejects.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("psso-ext", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });

    // Trigger key generation
    await getOrGenerateDpopKeyPair();

    const record = await new Promise<{ privateKey: CryptoKey; publicJwk: JsonWebKey } | null>(
      (resolve, reject) => {
        const tx = db.transaction("dpop-keys", "readonly");
        const req = tx.objectStore("dpop-keys").get("current");
        req.onsuccess = () => resolve(req.result as { privateKey: CryptoKey; publicJwk: JsonWebKey } | null);
        req.onerror = () => reject(req.error);
      },
    );
    db.close();

    expect(record).not.toBeNull();
    expect(record!.privateKey).toBeInstanceOf(CryptoKey);
    expect(record!.privateKey.extractable).toBe(false);

    // Attempting to export the private key must reject.
    await expect(
      crypto.subtle.exportKey("pkcs8", record!.privateKey),
    ).rejects.toThrow();
  });

  it("deleteIdbKey removes the IDB record and clears the in-process cache", async () => {
    const { getDpopThumbprint, deleteIdbKey, resetInMemoryKeyCache } = await importFresh();

    // Generate a key first
    const jkt1 = await getDpopThumbprint();
    expect(jkt1).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Delete it — this must remove the IDB row AND clear keyPromise
    await deleteIdbKey();

    // Verify IDB row is gone
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("psso-ext", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const row = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction("dpop-keys", "readonly");
      const req = tx.objectStore("dpop-keys").get("current");
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    expect(row).toBeNull();

    // Next getDpopThumbprint must regenerate (a fresh thumbprint may differ)
    const jkt2 = await getDpopThumbprint();
    expect(jkt2).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Suppress unused-var warning for resetInMemoryKeyCache
    void resetInMemoryKeyCache;
  });

  it("signDpopProof does not include cnf.jkt in the payload (RFC 9449 §4.2)", async () => {
    const { signDpopProof } = await importFresh();

    const proof = await signDpopProof({
      route: "/api/extension/token/exchange",
      method: "POST",
      serverUrl: "https://example.com",
    });

    const parts = proof.split(".");
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;

    // cnf.jkt belongs in the access token, not in the DPoP proof (RFC 9449 §4.2)
    expect(payload.cnf).toBeUndefined();
  });
});
