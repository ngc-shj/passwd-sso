# A06-2 — Manual smoke test plan

Run these after deploying A06-2 to verify the library swap works end-to-end.
Pre-1.0 dev repo per user direction (2026-05-23) — no cross-version vault
compat tested.

## Prerequisites

- Dev stack running: dev server (`npm run dev`).
- Browser opened to the app's locale-prefixed root.
- An ASCII passphrase ready (≥10 chars).
- An optional non-ASCII passphrase for the Unicode check.

## Step 1 — Vault setup with new master passphrase

1. Sign in with a fresh user (or one without a vault initialized).
2. Navigate to vault setup. Enter passphrase (e.g. `correct horse battery staple`).
3. Confirm vault initializes successfully.

**Expected**:
- `kdfType=1` (Argon2id) and `kdfMemory/kdfIterations/kdfParallelism` set on
  the user record.
- No console errors about `hash-wasm` import or WASM instantiation.

## Step 2 — Vault unlock with the just-set passphrase

1. Lock the vault (or sign out + sign in).
2. Unlock with the same passphrase.

**Expected**:
- Unlock succeeds; passphrase entry → derived key → wrap unwrap works.
- Browser DevTools network: the lazy-loaded hash-wasm chunk is fetched
  (~30 KB). Compare to pre-swap (argon2-browser was ~72 KB).

## Step 3 — Multibyte / Unicode passphrase

1. Lock the vault.
2. Use `change-passphrase` to switch to a multibyte passphrase
   (e.g. `パスワード123🔐`).
3. Lock + unlock with the new passphrase.

**Expected**:
- Lock + unlock succeeds. This is the production analog of the
  `unicode-multibyte` cross-impl test vector — proves hash-wasm's UTF-8 byte
  interpretation matches @noble's.

## Step 4 — Performance check

- During unlock, measure perceived latency on the vault-unlock screen
  (manual; dev tools Performance tab if precision needed).
- Compare to pre-swap perceived latency.

**Expected**:
- ~Same or slightly faster (hash-wasm is a more modern, actively-maintained
  WASM Argon2id; on default-prod-params t=3/m=64MB/p=4 takes ~150ms in Node
  spike — browser perf likely similar or better).

## Step 5 — CSP smoke (production-mode CSP)

- Run `NODE_ENV=production npm run build && NODE_ENV=production npm start`.
- Trigger vault unlock in a browser with DevTools Console open.

**Expected**:
- No CSP violation for `'wasm-unsafe-eval'` (hash-wasm uses
  `WebAssembly.compile/instantiate`, same as argon2-browser; directive
  retained in `csp-builder.ts`).
- No "Refused to compile a WebAssembly module" errors.

## Step 6 — Bundle size capture

Record once per swap:

```bash
du -h node_modules/argon2-browser     # → (pre-swap, ~150K)
du -h node_modules/hash-wasm          # → (post-swap, ~2.1M for full lib;
                                      #   only ~30K loaded at runtime)
ls -la node_modules/hash-wasm/dist/argon2.umd.min.js  # → 29.5K
```

Capture in commit message and verify the per-runtime chunk size is the
relevant metric (NOT the full node_modules tree — most of the 2.1 MB is
TypeScript source + per-algorithm UMD bundles never loaded).

## Acceptance

All 6 steps pass with the expected behaviour. Record any divergence in this
file under a "Findings" section before merging. If vault unlock fails for
ANY input that previously worked, **DO NOT MERGE** — the cross-impl test
should have caught this, so a failure here indicates a deeper issue.
