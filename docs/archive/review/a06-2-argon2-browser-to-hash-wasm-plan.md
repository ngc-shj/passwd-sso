# A06-2 — argon2-browser → hash-wasm (v2)

> **Plan v2** — round-1 review (3 expert sub-agents) found a Critical chain
> (F2/S1/S2/T1: locking `expectedHex` from hash-wasm's own output is circular
> proof) + multiple Majors (next.config.ts, doc references, edge inputs).
> v2 adopts a **cross-implementation oracle** strategy: hash-wasm (WASM) AND
> `@noble/hashes/argon2id` (pure JS, fully independent codebase) compute the
> same vectors; agreement = RFC 9106 conformance. @noble/hashes is added as
> a permanent devDep test oracle. See review log for the full findings table.

## Project context

- **Type**: web app (Next.js 16 / Auth.js v5 / Prisma 7) — client-side E2E vault
- **Affected file**: `src/lib/crypto/crypto-client.ts` (`argon2idHash`)
- **Callers**: only `deriveWrappingKeyArgon2id` → vault unlock/setup/change-passphrase/recovery/admin-reset
- **Risk**: Argon2id output mismatch = total data loss. Library swap MUST be
  RFC 9106-conformant. Per user direction (2026-05-23) pre-1.0 / no
  cross-version data migration; existing dev vaults may be reset.

## Objective

Replace stale `argon2-browser` (^1.18.0, last release 2020) with
`hash-wasm` (active, smaller per-algo chunks). Prove RFC 9106 conformance
via cross-implementation agreement with `@noble/hashes/argon2id` (independent
pure-JS impl) on 4 vectors covering: small params, default prod params,
empty passphrase, and Unicode multibyte passphrase.

### Library evaluation (corrected from v1)

| Library | Argon2id support | Maintenance | Bundle | API | Decision |
|---|---|---|---|---|---|
| `argon2-browser` ^1.18.0 | yes (WASM) | last release 2020 | ~46 KB JS + ~26 KB WASM | callback-shaped | **OUT** — stale |
| `hash-wasm` ^4.x | yes (WASM, lazy per-algo) | active (Daniel Wirtz) | smaller per-callsite chunks | Promise `argon2id({...})` | **IN** as production impl |
| `@noble/hashes` ^1.x | **yes** (pure-JS `argon2id` + `argon2idAsync` — v1 plan was wrong) | active (paulmillr) | ~tens of KB pure JS | `argon2id(password, salt, opts)` | **IN as devDep test oracle** |

## Scope decision

| Concern | In scope | Notes |
|---|---|---|
| Replace argon2-browser with hash-wasm in `argon2idHash` | ✅ | Single function rewrite |
| Drop argon2-browser dep + `src/types/argon2-browser.d.ts` | ✅ | Confirmed zero other callers |
| Add hash-wasm dep | ✅ | exact-pin (no caret) for crypto-critical dep |
| Add `@noble/hashes` as devDep oracle | ✅ | Test-only; not in production bundle |
| Update `next.config.ts` `serverExternalPackages` | ✅ | Remove argon2-browser; add hash-wasm only if SSR build fails |
| Update `csp-builder.ts` comment + `docs/security/threat-model.md` + `docs/security/cryptography-whitepaper.md` | ✅ | Doc references to argon2-browser |
| Cross-impl test (`argon2-vectors.test.ts`) on 4 vectors | ✅ | RFC 9106 conformance proof |
| Pre-impl Node spike: confirm hash-wasm runs in vitest Node | ✅ | Documented in §0 |
| Existing-vault unlock manual test | ❌ | Per pre-1.0 user direction; dropped from manual smoke |
| 256MB high-memory vector | ❌ | Exceeds vitest 10s timeout; conformance covered by smaller vectors |
| Re-encrypt existing vaults to new library | ❌ | Same Argon2id output (via cross-impl proof) → wraps remain valid |
| Production use of @noble/hashes | ❌ | Test-only; pure-JS is slower than WASM for prod KDF |

## Requirements

### Functional

- **F1** `argon2idHash(passphrase, salt, time, mem, parallelism)` outer
  signature unchanged. Body calls hash-wasm's `argon2id({...})`.
- **F2** Returns `Uint8Array` of length 32. No type cast — narrowed via
  `outputType: "binary" as const`.
- **F3** SSR-safe: same `webpackIgnore: true` + variable-indirection pattern.
  Inline comment updated (no `fs` reference; only WebAssembly globals
  required, available in Node + browser).
- **F4** `next.config.ts` `serverExternalPackages`: remove `"argon2-browser"`.
  Try without `"hash-wasm"`; add only if `npx next build` fails.
- **F5** CSP `wasm-unsafe-eval` retained (hash-wasm uses WebAssembly.compile).
- **F6** Cross-impl test in `argon2-vectors.test.ts`: 4 fixed vectors. For
  each, BOTH hash-wasm and @noble/hashes/argon2id compute the hash; the test
  asserts they agree AND that the agreed hex matches a hard-coded
  `expectedHex` (which is captured during the orchestrator's pre-impl run).
  Agreement across two independent codebases = RFC 9106 conformance.
- **F7** Existing `crypto-client.test.ts` mock replaced; `crypto-client.test.ts`
  passes (10 tests).

### Non-functional

- No `any`, no `as` casts in production source.
- ESLint clean; `npx tsc --noEmit`: pre-existing only.
- `npx vitest run`: 100% pass.
- `bash scripts/pre-pr.sh`: 24/24 PASS.
- `npx next build`: success.

## Supply-chain risk acceptance

| Dep | Maintainer | Repo | Runtime deps | npm audit | Pin policy |
|---|---|---|---|---|---|
| `hash-wasm` ^4.x | Daniel-Wirtz | github.com/Daniel-Wirtz/hash-wasm | 0 | (run during impl) | **exact-pin** (no caret) |
| `@noble/hashes` ^1.x | paulmillr | github.com/paulmillr/noble-hashes | 0 | (run during impl) | caret-pin (devDep only; lower risk) |

WASM tarball is opaque blob — same shape as argon2-browser had. Threat-model
note: shipping prebuilt WASM from a single maintainer is a residual risk
(supply-chain compromise of npm tarball); mitigated by lockfile integrity +
exact-pin. Add this note to threat-model.md as part of the doc updates.

## Migration risk acceptance

- Pre-1.0; user direction 2026-05-23 is "no data migration".
- Existing dev DB vaults derived with argon2-browser unlock IFF hash-wasm
  produces the same output. The cross-impl test proves RFC 9106 conformance
  by hash-wasm matching @noble/hashes (independent codebase). RFC-conformant
  hash-wasm + RFC-conformant @noble agreement → argon2-browser (also
  RFC-conformant — confirmed in regression testing pre-A06-2) → existing
  wraps unwrap.
- If a Unicode-passphrase user exists with an argon2-browser-derived wrap,
  the Unicode vector in the test confirms hash-wasm produces the same hex —
  i.e. NFC-or-raw byte interpretation agrees.

## Technical approach

### §0 — Pre-impl Node spike (gate)

Before any source change, the orchestrator runs:

```bash
npm install --save-dev hash-wasm @noble/hashes
node -e 'import("hash-wasm").then(async m => {
  const h = await m.argon2id({
    password: "password",
    salt: new Uint8Array([0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08]),
    parallelism: 1, iterations: 2, memorySize: 65536, hashLength: 32, outputType: "binary",
  });
  console.log("hash-wasm:", Buffer.from(h).toString("hex"));
})'
```

If this fails (e.g. WASM init error in Node), the swap **cannot use vitest
Node**; we must add `@vitest/browser` + Playwright runner. Documented before
proceeding.

### §1 — Dependency change

```bash
npm uninstall argon2-browser
npm install hash-wasm@<exact-version>
npm install --save-dev @noble/hashes@<exact-version>
rm src/types/argon2-browser.d.ts
```

`<exact-version>` resolved at impl time and pinned (no caret).

### §2 — `crypto-client.ts` rewrite

```ts
export async function argon2idHash(
  passphrase: string,
  salt: Uint8Array,
  time: number,
  mem: number,
  parallelism: number
): Promise<Uint8Array> {
  // Dynamic import + variable indirection: keeps hash-wasm out of SSR static
  // analysis. hash-wasm requires only WebAssembly globals (compile + instantiate),
  // which exist in Node 18+ and all evergreen browsers.
  const moduleName = "hash-wasm";
  const { argon2id } = await import(/* webpackIgnore: true */ moduleName);
  return argon2id({
    password: passphrase,
    salt,
    parallelism,
    iterations: time,
    memorySize: mem,
    hashLength: 32,
    outputType: "binary" as const,
  });
}
```

No type cast — the `as const` narrows `outputType` and hash-wasm's conditional
return type yields `Uint8Array` automatically.

### §3 — `next.config.ts`

```diff
-  serverExternalPackages: ["file-type", "argon2-browser", ...],
+  serverExternalPackages: ["file-type", ...],
```

Try without `"hash-wasm"` first. Add it back only if `npx next build` fails
on SSR. Document outcome in commit message.

### §4 — `crypto-client.test.ts` mock replacement

Use `Parameters<typeof argon2id>[0]` to bind the mock's input shape to
hash-wasm's real type (catches future API drift):

```ts
vi.mock("hash-wasm", () => ({
  argon2id: async (opts: Parameters<typeof import("hash-wasm")["argon2id"]>[0]) => {
    // Deterministic PBKDF2 stand-in — fast test substitute, NOT real Argon2id.
    // Real conformance proven by `argon2-vectors.test.ts` against @noble/hashes.
    const passBytes = typeof opts.password === "string"
      ? new TextEncoder().encode(opts.password)
      : opts.password as Uint8Array;
    const saltBytes = opts.salt as Uint8Array;
    const paramSuffix = new TextEncoder().encode(
      `argon2id:t=${opts.iterations}:m=${opts.memorySize}:p=${opts.parallelism}`,
    );
    const combinedSalt = new Uint8Array(saltBytes.length + paramSuffix.length);
    combinedSalt.set(saltBytes);
    combinedSalt.set(paramSuffix, saltBytes.length);
    const keyMaterial = await crypto.subtle.importKey(
      "raw", passBytes, "PBKDF2", false, ["deriveBits"],
    );
    // 1000 iter — fast test stand-in; production enforces 3 iter Argon2id via
    // deriveWrappingKeyArgon2id. PBKDF2 1000 iter is NOT a secure floor — mock only.
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: combinedSalt, iterations: 1000, hash: "SHA-256" },
      keyMaterial,
      opts.hashLength * 8,
    );
    return new Uint8Array(bits);
  },
}));
```

### §5 — `argon2-vectors.test.ts` (new file)

Cross-implementation oracle. Does NOT mock hash-wasm or @noble.

```ts
import { describe, it, expect } from "vitest";
import { argon2id as hashWasmArgon2id } from "hash-wasm";
import { argon2idAsync as nobleArgon2id } from "@noble/hashes/argon2";

interface Vector {
  name: string;
  password: string;
  salt: Uint8Array;
  t: number;       // iterations
  m: number;       // memorySize KiB
  p: number;       // parallelism
  expectedHex: string; // captured at impl time from agreement of both impls
}

// 4 vectors covering: small params (fast CI), default prod params, empty pw, Unicode pw.
const VECTORS: Vector[] = [
  { name: "small/p=1/t=2/m=64KB",        password: "password",    salt: new Uint8Array(16).fill(0x01), t: 2, m: 65536, p: 1, expectedHex: "<populate-at-impl>" },
  { name: "default-prod-params",         password: "correct horse battery staple", salt: new Uint8Array(32).fill(0xab), t: 3, m: 65536, p: 4, expectedHex: "<populate-at-impl>" },
  { name: "empty-passphrase",            password: "",            salt: new Uint8Array(16).fill(0x02), t: 2, m: 65536, p: 1, expectedHex: "<populate-at-impl>" },
  { name: "unicode-multibyte",           password: "パスワード🔐",   salt: new Uint8Array(16).fill(0x03), t: 2, m: 65536, p: 1, expectedHex: "<populate-at-impl>" },
];

const hex = (u: Uint8Array) => Array.from(u).map(b => b.toString(16).padStart(2,"0")).join("");

describe("argon2id RFC 9106 conformance via cross-implementation oracle", () => {
  it.each(VECTORS)("$name — hash-wasm and @noble/hashes agree", async (v) => {
    const a = await hashWasmArgon2id({
      password: v.password, salt: v.salt,
      parallelism: v.p, iterations: v.t, memorySize: v.m, hashLength: 32,
      outputType: "binary" as const,
    });
    const b = await nobleArgon2id(v.password, v.salt, { t: v.t, m: v.m, p: v.p, dkLen: 32 });

    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBe(32);
    expect(b).toBeInstanceOf(Uint8Array);
    expect(b.length).toBe(32);

    const aHex = hex(a);
    const bHex = hex(b);

    // Cross-impl agreement → RFC 9106 conformance (two independent codebases agree).
    expect(aHex).toBe(bHex);
    // Pinned hex captured during impl — locks the value so future hash-wasm
    // or @noble upgrades that BOTH regress fail this test (vs locking only one
    // impl's output, which would mask coordinated drift).
    expect(aHex).toBe(v.expectedHex);
  });
});
```

The orchestrator runs the test ONCE with `expectedHex` left as
`"<populate-at-impl>"` and a temporary `console.log(aHex, "===", bHex)`. The
two outputs print; the orchestrator visually confirms agreement; pastes the
agreed hex into `expectedHex`; removes the console.log; commits.

### §6 — Doc updates

- `docs/security/cryptography-whitepaper.md:139` — replace "argon2-browser"
  with "hash-wasm".
- `docs/security/threat-model.md:174` — update §M2 wording: remove "Eliminating
  this risk requires migrating off argon2-browser" (done); reframe as
  residual-risk note about prebuilt WASM tarballs.
- `src/lib/security/csp-builder.ts:90-106` — update the inline argon2-browser
  references to hash-wasm; the `wasm-unsafe-eval` directive itself stays.

## Tests

### Automatic (vitest)

- `crypto-client.test.ts` — 10 tests, mock-based plumbing. Must pass.
- `argon2-vectors.test.ts` (new) — 4 cross-impl vectors. Must pass.

### Manual smoke (post-impl)

1. Start dev stack; sign in.
2. **Drop step**: existing-vault unlock (per pre-1.0 user direction).
3. setup-master-passphrase — create a new vault, lock + unlock with various passphrases including a multibyte one.
4. change-passphrase — verify wrap rotation works.
5. Record bundle size:
   - `du -sh node_modules/argon2-browser` (before) — captured to commit msg
   - `du -sh node_modules/hash-wasm` (after) — captured to commit msg
   - `du -sh .next/static/chunks/*.wasm` (before/after, if any) — to commit msg

## Out of scope

- Re-encrypting existing vaults to new library — same RFC output.
- Migrating vault KDF to a different algorithm — Argon2id stays.
- `@noble/hashes` in production — test oracle only.
- 256 MiB high-memory vector — exceeds vitest 10s timeout; smaller vectors
  prove conformance.

## Considerations / risks

- **R1**: hash-wasm WASM init time differs from argon2-browser. Manual smoke
  captures perceived latency.
- **R2**: `wasm-unsafe-eval` CSP retained (same as before).
- **R3**: Vitest in Node mode running hash-wasm — verified by §0 Node spike
  BEFORE committing. If fails, escalate to browser runner.
- **R4**: `outputType: "binary"` returns `Uint8Array`. Locked via `as const`
  + runtime `instanceof Uint8Array` assertion.
- **R5**: hash-wasm accepts `string|Buffer|TypedArray` for salt; our wrapper
  signature stays `Uint8Array` for type discipline.
- **R6**: Supply-chain — prebuilt WASM tarball remains a residual risk
  (single maintainer, opaque blob). Mitigated by exact-pin + lockfile
  integrity. Documented in threat-model.md.

## Acceptance gates

- `bash scripts/pre-pr.sh`: 24/24 PASS.
- `npx vitest run`: 100% PASS (incl. 4 new vector tests).
- `npx next build`: success.
- Manual smoke per §Tests passes.
- Commit message includes: hash-wasm + @noble/hashes pinned versions, npm
  audit output for both, bundle size delta.

## Round-1 review log

See `a06-2-argon2-browser-to-hash-wasm-review.md`.
