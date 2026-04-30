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
