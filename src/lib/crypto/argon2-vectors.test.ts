/**
 * A06-2 — Argon2id RFC 9106 conformance via cross-implementation oracle.
 *
 * Two independent Argon2id implementations compute the same vector; agreement
 * proves RFC 9106 conformance (a single-impl bug would have to be replicated
 * byte-for-byte in the other codebase, which is implausible):
 *   - hash-wasm: production WASM impl used by `argon2idHash` in `crypto-client.ts`.
 *   - @noble/hashes/argon2: devDep oracle, pure-JS impl by paulmillr (no shared
 *     code with hash-wasm).
 *
 * The expectedHex values were captured by running both impls during the
 * A06-2 implementation; they are pinned so that a future upgrade of either
 * library that introduces a regression fails this test (cross-impl divergence
 * caught) and so that a coordinated upgrade-both-and-regress-the-same-way is
 * also caught (pinned hex mismatch).
 *
 * Does NOT mock either library — exercises real WASM + real pure-JS.
 *
 * WARNING — regeneration policy: if a future hash-wasm or @noble/hashes
 * upgrade breaks this test, DO NOT simply copy the new hex back over the
 * pinned values. The pinned hex is the conformance anchor. Investigate first:
 * verify the new output against an independent third-party reference
 * (e.g. RustCrypto `argon2` crate, libsodium `crypto_pwhash_str_alg`, PHC
 * reference CLI). Only update the pin after the third reference agrees.
 *
 * Known cross-impl divergences (not RFC 9106 conformance issues):
 *   - hash-wasm REJECTS empty password (`"Password must be specified"`).
 *     @noble/hashes accepts it. Tested below as `it("hash-wasm rejects empty password")`.
 *     Production callers (`deriveWrappingKeyArgon2id`) never pass `""` due to
 *     upstream passphrase length validation, but the rejection contract is
 *     locked here so a future hash-wasm change that starts accepting empty
 *     input is detected.
 */

import { describe, it, expect } from "vitest";
import { argon2id as hashWasmArgon2id } from "hash-wasm";
import { argon2id as nobleArgon2id } from "@noble/hashes/argon2.js";

interface Vector {
  name: string;
  password: string;
  salt: Uint8Array;
  t: number; // iterations
  m: number; // memorySize KiB
  p: number; // parallelism
  expectedHex: string;
}

// Captured 2026-05-23 via cross-impl Node spike. Each value asserted equal
// by BOTH hash-wasm v4 and @noble/hashes v2 (argon2id). Coverage:
// - small/p=1: minimal RFC-style params (fast CI)
// - default-prod-params: matches DEFAULT_KDF_PARAMS in crypto-client.ts
// - unicode-multibyte: Japanese kanji + emoji passphrase — locks NFC-or-raw
//   byte interpretation across impls
// - min-mem-min-iter: boundary inputs accepted by deriveWrappingKeyArgon2id
//   validation (memory ≥ 16384 KiB, parallelism ≥ 1, iterations ≥ 1)
const VECTORS: Vector[] = [
  {
    name: "small/p=1/t=2/m=64KB",
    password: "password",
    salt: new Uint8Array(16).fill(0x01),
    t: 2,
    m: 65536,
    p: 1,
    expectedHex: "ac9cb351182403e35fda25495dc734bfcf2a051f5d2e413c512fb926e050a65a",
  },
  {
    name: "default-prod-params",
    password: "correct horse battery staple",
    salt: new Uint8Array(32).fill(0xab),
    t: 3,
    m: 65536,
    p: 4,
    expectedHex: "7762c33a6eb625e645838740a5d63ff12cfb633fd8626f515454c2bf768e0d53",
  },
  {
    name: "unicode-multibyte",
    password: "パスワード🔐",
    salt: new Uint8Array(16).fill(0x03),
    t: 2,
    m: 65536,
    p: 1,
    expectedHex: "4ba819370e810cc39942e98d8cf61d96b313158257744435fc09760516cf62d6",
  },
  {
    name: "min-mem-min-iter",
    password: "test",
    salt: new Uint8Array(8).fill(0xcd),
    t: 1,
    m: 16384,
    p: 1,
    expectedHex: "b0b3170e48864831cb708fcf8d76293c9bc61e4f69b38c6f3dcb3814d7746bd5",
  },
];

const toHex = (u: Uint8Array): string =>
  Array.from(u)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

describe("Argon2id RFC 9106 conformance (cross-impl oracle)", () => {
  // Per-test timeout: default-prod-params takes ~150ms; t=2/m=64KB ~80ms.
  // Plenty under vitest's 10s default.
  it.each(VECTORS)(
    "$name — hash-wasm and @noble/hashes produce the same hash",
    async (v) => {
      const a = await hashWasmArgon2id({
        password: v.password,
        salt: v.salt,
        parallelism: v.p,
        iterations: v.t,
        memorySize: v.m,
        hashLength: 32,
        outputType: "binary" as const,
      });
      const b = nobleArgon2id(v.password, v.salt, {
        t: v.t,
        m: v.m,
        p: v.p,
        dkLen: 32,
      });

      // Shape guards — catches a future hash-wasm major-version return-type change.
      expect(a).toBeInstanceOf(Uint8Array);
      expect(a.length).toBe(32);
      expect(b).toBeInstanceOf(Uint8Array);
      expect(b.length).toBe(32);

      const aHex = toHex(a);
      const bHex = toHex(b);

      // Cross-impl agreement: two independent codebases produce the same hash.
      expect(aHex).toBe(bHex);
      // Pinned hex: locks the value so a coordinated regression in BOTH impls
      // (or a regression in one that the other happens to mirror) also fails.
      expect(aHex).toBe(v.expectedHex);
    },
  );

  // Locks the documented divergence: hash-wasm rejects empty password where
  // @noble/hashes accepts it. If a future hash-wasm change starts accepting
  // empty input, this test fails and `deriveWrappingKeyArgon2id` callers need
  // re-audit.
  it("hash-wasm rejects empty password (documented divergence from @noble)", async () => {
    await expect(
      hashWasmArgon2id({
        password: "",
        salt: new Uint8Array(16).fill(0x01),
        parallelism: 1,
        iterations: 2,
        memorySize: 65536,
        hashLength: 32,
        outputType: "binary" as const,
      }),
    ).rejects.toThrow(/password/i);
  });
});
