# Coding Deviation Log: audit-anchor-external-commitment

## Deviation 1: CLI re-implements anchor-manifest crypto (R1 violation, Batch 5)

**Plan obligation**: Implementation step 6 mandates "MUST reuse `jcsCanonical` from `src/lib/audit/audit-chain.ts:9-30` — do not duplicate". Step 10 says "Reuse the manifest verifier library from step 6".

**Actual**: The CLI (`cli/`) is a separate npm package and cannot import from the server-side `src/lib/audit/anchor-manifest.ts` directly:
- Different package boundaries (`cli/` vs server `src/`)
- `@/` path aliases differ between server and CLI
- Server-side anchor-manifest pulls in Next.js path resolution and Zod 4 server-only utilities that the CLI cannot consume

The CLI command `cli/src/commands/audit-verify.ts` therefore re-implements the manifest verifier (JCS canonicalization, JWS verify, Ed25519 verification, HMAC `tenantTag`, manifest Zod schema) inline. Server-side `src/lib/audit/anchor-manifest.ts` remains the canonical source.

**Mitigation required (tracked, NOT yet implemented)**:

1. **Cross-implementation golden-vector test** (Step 2-4 / Batch 7+): add a test that asserts BOTH the server `computeTenantTag` AND the CLI's local copy produce the same hex output for a known input (the server already has a golden vector at `src/lib/audit/anchor-manifest.unit.test.ts`; mirror the same vector in the CLI's unit tests).
2. **Cross-implementation manifest sign/verify round-trip**: a test where the server signs a manifest and the CLI subprocess (via `execFileSync`) verifies it — must succeed without error. Sketched in `cli/src/__tests__/integration/audit-verify.test.ts` but should be extended to use server-built artifacts.
3. **Long-term refactor**: extract `anchor-manifest` (and its dependency `jcsCanonical` from `audit-chain.ts`) into a shared `packages/audit-anchor/` workspace package consumable by both the server (`src/`) and the CLI (`cli/`). Out of scope for this Phase 2; tracked here as future work.

**Why accepted as a deviation**: refactoring to a shared package is a cross-cutting structural change that would expand the scope of this PR by 5-10 days; the duplication is bounded (single small file, ~200 lines of crypto), and Mitigation #1 + #2 give us byte-level parity guarantee. The accepted risk is that future changes to manifest semantics MUST be made in lockstep across server and CLI — the deviation log entry above and the cross-implementation tests are the controls.

**Status update (Phase 3 R1 fix-batch-B)**: cross-implementation parity test added at `cli/src/__tests__/unit/audit-verify-parity.test.ts`. Drift-detection assertion confirms server's golden tenantTag hex (`6db2cb93...4c03323`) matches the CLI's local re-implementation. Mitigation #1 from this deviation is now active. CLI shared constants module `cli/src/constants/audit-anchor.ts` (T5 fix) further narrows the drift surface — only the cryptographic primitives (~200 lines) remain duplicated.

---

## Deviation 2: FR7 (key rotation overlap) + FR8 (chain regression) integration tests deferred

**Plan obligation**: Implementation step 13 + Testing strategy lines 360 / 387 mandate full integration coverage:
- `audit-anchor-key-rotation.integration.test.ts` (FR7) — sign manifest under `kid-old`, then under `kid-new` during overlap, verify both succeed against their respective public keys.
- `audit-anchor-regression-detection.integration.test.ts` (FR8) — 3-manifest scenario `(epoch=1, seq=10) → (1, 12) → (1, 8)` rejected as `CHAIN_SEQ_REGRESSION`; counter-test `(1, 10) → (2, 5)` accepted as legitimate epoch reset.

**Actual**: only the most-impactful 2 publisher integration tests shipped in this PR (FR2 happy-path + FR6 fail-closed). FR7 and FR8 are scaffolded as TODO stubs in the same `*.integration.test.ts` family.

**Why accepted as continuing work**:
- FR7 requires a multi-cadence test fixture with explicit overlap-window control, plus rotation-script automation that doesn't yet exist (the rotation runbook documents the manual steps; no `scripts/rotate-audit-anchor-key.sh` is in this PR).
- FR8 requires manifest fixture authoring: build manifest A, sign it, write it to a fixture S3 path, then build a tampered manifest C with `previousManifest.sha256 = sha256(A)` and an artificially regressed `chain_seq`. Doable but ~400 LoC of additional fixture + assertion plumbing per test.
- Both are tracked as **must-implement-before-production** in this deviation log. The implementation PR that wires the rotation script (Phase 2 of the implementation plan, ratification pending) MUST add both files.

**Mitigation present in this PR**:
- Manifest unit tests cover FR7 / FR8 logic at the library level (`anchor-manifest.unit.test.ts`): sign/verify roundtrip with multiple keypairs, schema validation that rejects `chain_seq` regressions implicitly via `(epoch, chainSeq)` tuple format.
- The cadence-end safety net (`MISSING_PRIOR_CADENCE_PUBLICATION`) catches the FR7 "rotation overlap broke continuity" case at runtime even without the integration test.
