# Plan: prf-handoff-zeroization

## Project context

- Type: web app (Next.js client component crypto path) + shared crypto lib
- Test infrastructure: unit + integration (vitest); existing tests for all four touched files
- Scope: client-side, browser-only PRF (WebAuthn) handoff. No server changes.

## Objective

Harden the in-memory PRF handoff (`src/lib/auth/prf-handoff.ts`, introduced in the
pre-v1.0 XSS-hardening sweep that moved `psso:prf-output` / `psso:prf-data` off
`sessionStorage`) so that the PRF output — a sensitive secret that unwraps the
vault secret key — is zeroizable and is actually zeroized on every code path.

Two residual defense-in-depth gaps remain after the sessionStorage removal:

1. **Immutable-string residue**: `PrfHandoff.prfOutputHex` is a hex `string`.
   JS strings are immutable, so the PRF output cannot be wiped — it lingers in
   the JS heap until GC. The producer zeroizes its own `Uint8Array` but the hex
   copy survives in the module-level `pending` variable and in the consumer's
   local until GC.
2. **Uncovered exit paths**: neither the producer nor the consumer zeroizes the
   PRF `Uint8Array` on all exits.
   - Producer (`passkey-signin-button.tsx`, `security-key-signin-form.tsx`):
     `prfOutput` is declared via `const { responseJSON, prfOutput } = await
     startPasskeyAuthentication(...)` inside `try`, so it is out of scope in
     `catch`/`finally`. If `fetchApi`/`verifyRes.json()` throws, or if
     `prfOutput` is truthy but `verifyData.prf` is falsy, the buffer is never
     `fill(0)`-ed.
   - Consumer (`vault-context.tsx unlockWithStoredPrf`): early `return false` on
     `!dataRes.ok` (non-401) and on `!vaultData.accountSalt` skip zeroization;
     only the narrow `try/finally` around `unwrapSecretKeyWithPrf` wipes it.

Severity: low (defense-in-depth). The primary XSS threat — enumerable
`sessionStorage` — is already closed. JS-heap buffers are not enumerable via web
APIs. This change reduces the lifetime of an unwrapping secret in memory.

## Requirements

- Functional: vault auto-unlock after PRF passkey/security-key sign-in continues
  to work unchanged (same success path, same graceful degradation to manual
  unlock after a full reload).
- Non-functional: the PRF output buffer is zeroized on every exit path of both
  producer and consumer; no immutable-string copy of the PRF output is created.
- No behavior change to the non-PRF sign-in path.

## Technical approach

Change `PrfHandoff` to carry the PRF output as a `Uint8Array` (ownership-transfer
model) instead of a hex string. This removes the immutable-string residue (gap 1)
and removes the `hexEncode`/`hexDecode` round-trip. Ownership semantics:

- `stashPrf` takes ownership of the passed buffer. The producer MUST NOT zeroize
  the buffer it stashed (that buffer now lives in the handoff). It zeroizes only
  on paths where it did NOT stash.
- `takePrf` transfers ownership to the consumer, which zeroizes after use.
- `stashPrf` overwrite and `clearPrf` zeroize the buffer they drop, so an
  abandoned handoff is wiped *when code runs*.

**Residue floor / honest scoping** (security review S1 + Info): the
zeroization here is best-effort heap-residency reduction, not a guarantee of
zero residue:
- `clearPrf()` currently has **no production caller** (tests only). Its
  zeroize duty is therefore *latent* — the realistic abandonment scenario (user
  signs in → PRF stashed → full page reload before reaching the dashboard) drops
  the module via GC with no code running to wipe. `clearPrf` cannot help there.
  The only path that actually wipes an abandoned buffer is the next sign-in's
  `stashPrf` overwrite. This plan adds zeroization to `clearPrf` for correctness
  and so a future caller benefits, but does NOT claim it closes the full-reload
  residue — that residue is accepted/unavoidable.
- The source `prfOutput` is itself `new Uint8Array(prfResults.first)`
  (`webauthn-client.ts:380`); the browser-owned `prfResults.first` ArrayBuffer is
  un-wipeable and out of reach. So "no un-wipeable copy exists" is not literally
  true at the WebAuthn boundary — the residency floor is set by the browser, not
  this code. The improvement is real but bounded.

Producer is restructured so `prfOutput` lives in an outer `let` and is zeroized
in `finally` on every path except the one where ownership was transferred to the
handoff (set the local to `null` after a successful `stashPrf`).

Consumer is restructured so a single `try/finally` around the whole post-`takePrf`
body zeroizes the buffer once, covering all early returns and throws.

## Contracts

### C1 — `PrfHandoff` shape + lifecycle (`src/lib/auth/prf-handoff.ts`)

Signature:
```ts
export interface PrfHandoff {
  prfOutput: Uint8Array;              // was: prfOutputHex: string
  prfData: { prfEncryptedSecretKey: string; prfSecretKeyIv: string; prfSecretKeyAuthTag: string };
}
export function stashPrf(handoff: PrfHandoff): void;  // zeroizes prior pending.prfOutput before overwrite
export function hasPrf(): boolean;
export function takePrf(): PrfHandoff | null;          // single-use; does NOT zeroize (consumer owns)
export function clearPrf(): void;                      // zeroizes pending.prfOutput, then drops
```

Invariants:
- `prfOutput` is a `Uint8Array` everywhere in the handoff; no hex string of the
  PRF output is ever constructed.
- `stashPrf` and `clearPrf` are the only places that may zeroize a *pending*
  buffer (an overwritten/abandoned one). `takePrf` never zeroizes — it hands the
  buffer to the consumer.

Acceptance:
- `stashPrf(a); stashPrf(b)` zeroizes `a.prfOutput` (all bytes 0) and leaves
  `b.prfOutput` intact and returned by `takePrf`.
- `clearPrf` after a stash zeroizes the dropped buffer; subsequent `takePrf`
  returns `null`.
- `takePrf` returns the same `Uint8Array` reference that was stashed (no copy).

#### Consumer-flow walkthrough for C1

Consumer A (`src/lib/vault/vault-context.tsx` `unlockWithStoredPrf`) reads
`{ prfOutput, prfData }` and uses `prfOutput` as the second arg to
`unwrapSecretKeyWithPrf(prfData-bundle, prfOutput)`, then zeroizes `prfOutput`
once in a `finally` covering the whole function body. It uses `prfData`'s three
fields to build the wrapped-key bundle. All fields the consumer reads
(`prfOutput`, `prfData.prfEncryptedSecretKey`, `prfData.prfSecretKeyIv`,
`prfData.prfSecretKeyAuthTag`) are present in the locked C1 shape.

Producer A (`src/components/auth/passkey-signin-button.tsx`) and Producer B
(`src/components/auth/security-key-signin-form.tsx`) WRITE the contract:
`stashPrf({ prfOutput, prfData: verifyData.prf })`. `prfOutput` is the
`Uint8Array | null` from `startPasskeyAuthentication`; the stash happens only
inside `if (prfOutput && verifyData.prf)`, so the narrowed non-null `Uint8Array`
is passed. `verifyData.prf` is the server-returned bundle with exactly the three
`prfData` fields.

### C2 — Producer zeroization (both sign-in components)

Signature (structure, both files identical in shape):
```ts
let prfOutput: Uint8Array | null = null;
try {
  ...
  const result = await startPasskeyAuthentication(options, prfSalt || undefined);
  prfOutput = result.prfOutput;
  // read result.responseJSON below (do NOT re-destructure into a new const —
  // that would shadow the outer `let prfOutput` and defeat finally-zeroization)
  ... JSON.stringify(result.responseJSON) ...
  ...
  if (prfOutput && verifyData.prf) {
    stashPrf({ prfOutput, prfData: verifyData.prf });
    prfOutput = null;   // ownership transferred — do not zeroize below
  }
  ...
} catch (err) { ... } finally {
  prfOutput?.fill(0);
  setLoading(false);
}
```

Invariants:
- `prfOutput` is zeroized in `finally` on every path where it was NOT stashed
  (error throw, `!verifyRes.ok`, `prfOutput && !verifyData.prf`, no-PRF where it
  is already `null`).
- The pre-existing inline `prfOutput?.fill(0)` in the `!verifyRes.ok` branch is
  removed (now covered by `finally`); no double-wipe, no missed wipe.
- The success destructuring must not shadow the outer `prfOutput` — read
  `result.responseJSON` / `result.prfOutput` instead of re-destructuring into a
  new `const`. `responseJSON` is load-bearing — it is consumed at
  `JSON.stringify(result.responseJSON)` in the verify request body
  (`passkey-signin-button.tsx:63`, `security-key-signin-form.tsx:75`); the
  restructure MUST preserve that read.
- The `hexEncode` import becomes unused in BOTH producers once
  `hexEncode(prfOutput)` is removed (it has no other use in these two files —
  `passkey-signin-button.tsx:8`, `security-key-signin-form.tsx:9-13`). Remove the
  import. (`@typescript-eslint/no-unused-vars` is `warn`, so build still passes,
  but the standing rule is to fix the warning.) Note: `vault-context.tsx` keeps
  `hexDecode`/`hexEncode` — they are used elsewhere (accountSalt etc.); only the
  line-666 `hexDecode(handoff.prfOutputHex)` use goes away there.

Forbidden patterns:
- pattern: `const { responseJSON, prfOutput }` — reason: re-destructuring shadows the outer `let`, defeating finally-zeroization
- pattern: `prfOutputHex` — reason: hex-string residue removed in C1
- pattern: `hexEncode(prfOutput)` — reason: no hex copy of PRF output

Acceptance:
- On `fetchApi` throw after `startPasskeyAuthentication`, the obtained buffer is
  zeroized (test: mock fetch to reject, assert buffer all-zero).
- On `verifyData.prf` absent, buffer is zeroized and `stashPrf` not called.
- On success, `stashPrf` is called with the buffer and the buffer is NOT
  zeroized by the producer.

### C3 — Consumer single zeroization (`unlockWithStoredPrf`)

Signature (structure):
```ts
const handoff = takePrf();
if (!handoff) return false;
const prfOutput = handoff.prfOutput;   // was: hexDecode(handoff.prfOutputHex)
try {
  ... all existing logic, early returns and throws unchanged ...
} finally {
  prfOutput.fill(0);
}
```

Invariants:
- One `finally` zeroizes `prfOutput` for the whole function body; the inner
  `try/finally` that previously wrapped only `unwrapSecretKeyWithPrf` is removed
  (its job folds into the outer finally).
- `secretKey` zeroization on its own error paths is unchanged (out of scope for
  this fix; do not regress it).

Forbidden patterns:
- pattern: `hexDecode(handoff.prfOutput` — reason: prfOutput is now a Uint8Array, not hex

Acceptance:
- On `!dataRes.ok` (non-401) early return, `prfOutput` is zeroized.
- On `!vaultData.accountSalt` early return, `prfOutput` is zeroized.
- On the happy path, `prfOutput` is zeroized after unwrap; vault unlock still
  succeeds (existing test passes with Uint8Array handoff).

### C4 — Test updates

Assertion idiom: use bare `buf.every((b) => b === 0)` for "wiped" and
`buf.some((b) => b !== 0)` for "intact" (matches the two edited files'
convention; no `Array.from` wrapper needed for `Uint8Array`).

- `src/lib/auth/prf-handoff.test.ts`: replace `prfOutputHex` sample with a
  `Uint8Array`; assert `takePrf` returns the **same reference** (not a copy);
  assert `stashPrf` overwrite zeroizes the dropped prior buffer; assert
  `clearPrf` zeroizes the pending buffer.

- `src/components/auth/passkey-signin-button.test.tsx` &
  `security-key-signin-form.test.tsx`:
  - **INVERT the existing success-path zeroization assertion** (currently
    `expect(prfBytes.every((b) => b === 0)).toBe(true)` at
    `passkey-signin-button.test.tsx:140-141` and the parallel block in the
    security-key test). Under the ownership-transfer model the producer must NOT
    wipe on success. Replace with BOTH:
    - `expect(mockStashPrf).toHaveBeenCalledWith({ prfOutput: prfBytes, prfData })`
      — the *same live reference* is stashed, and
    - `expect(prfBytes.some((b) => b !== 0)).toBe(true)` — producer did NOT wipe
      the transferred buffer.
    This is the cross-component double-wipe regression guard. Leaving the old
    `every(b===0)===true` would either fail the suite or, if "fixed to green" by
    keeping the producer wipe, ship the double-wipe bug.
  - **New: `fetchApi` rejects after `startPasskeyAuthentication`** — resolve
    `startPasskeyAuthentication` with `prfBytes`, mock options `ok`, then mock
    `/verify` to reject → assert `prfBytes.every((b) => b === 0)` (finally wiped).
    No existing test covers this (today's reject tests reject *before* the buffer
    exists).
  - **New: `prfOutput && !verifyData.prf` branch** (user scenario 3, vault not
    PRF-enrolled) — `/verify` returns `ok` with no `prf` field → assert
    `mockStashPrf` NOT called AND `prfBytes.every((b) => b === 0)`.
  - Keep the existing `sessionStorage.getItem("psso:prf-output") === null` and
    `psso:webauthn-signin` assertions.
  - Remove now-dead scaffolding: `expectedHex = "ab".repeat(32)` locals and the
    `mockHexEncode` mock (no longer referenced once `prfOutputHex` is dropped).

- `src/lib/vault/vault-context.test.tsx`:
  - Stash a `Uint8Array` (drop `hexEncode(prfOutput)`); hold the reference so
    the new assertions can inspect it (the Uint8Array handoff returns the same
    ref via `takePrf`, which is exactly what makes these assertions possible —
    the old `hexDecode` path created an internal buffer the test could not see).
  - **New: `!dataRes.ok` (non-401) early return** — stash a buffer, make
    `/api/vault/unlock/data` return `{ ok: false, status: 500 }` →
    `unlockWithStoredPrf()` returns `false` AND stashed buffer
    `every((b) => b === 0)`.
  - **New: `!vaultData.accountSalt` early return** — `/unlock/data` returns
    `ok:true` with `accountSalt` stripped → returns `false` AND buffer wiped.
  - Preserve the existing end-to-end success test (`encryptionKey instanceof
    CryptoKey`) — it guards the consumer side against a zeroed stashed buffer.

Acceptance: `npx vitest run` green; `npx next build` green.

## Testing strategy

Unit tests per C4. The zeroization assertions follow the project's existing
buffer-wipe test idiom (assert `Array.from(buf).every(b => b === 0)`). No new
test framework. Build verification mandatory (client component + crypto path).

## Considerations & constraints

- Ownership-transfer is the subtle part: a double-zeroize (producer wipes the
  stashed buffer) would corrupt the consumer's unwrap. C2's `prfOutput = null`
  after `stashPrf` is the guard; C2 forbidden-pattern grep guards the shadowing
  re-destructure that would reintroduce the bug.
- Full page reload still drops the buffer un-zeroized (module GC) — unavoidable
  and unchanged; graceful degradation to manual unlock is the existing behavior.
- Out of scope: `secretKey` lifetime hardening in `unlockWithStoredPrf`
  (separate buffer, separate finding if any) — must not be regressed.

## User operation scenarios

1. Discoverable passkey sign-in with PRF → dashboard auto-unlocks (no second
   ceremony). Buffer zeroized after unlock.
2. Email security-key sign-in with PRF → same.
3. PRF passkey where server returns no `prf` bundle (vault not PRF-enrolled) →
   no stash, buffer zeroized, manual unlock prompt.
4. Network failure during verify → error shown, buffer zeroized.
5. Full reload between sign-in and dashboard → handoff gone, manual unlock.

## Go/No-Go Gate

| ID | Subject                                            | Status |
|----|----------------------------------------------------|--------|
| C1 | PrfHandoff Uint8Array shape + lifecycle            | locked |
| C2 | Producer finally-zeroization (2 components)        | locked |
| C3 | Consumer single finally-zeroization                | locked |
| C4 | Test updates (4 files)                             | locked |
