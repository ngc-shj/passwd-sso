# Coding Deviation Log: passkey-signin-client-token-cascade

## D1 — C1 input carries the raw session token, not a digest
- Plan: `CappedSessionInput.sessionTokenDigest`.
- Implemented: `CappedSessionInput.sessionToken` holds the raw cookie token, and `session-concurrency.ts` computes `hashSessionToken(input.sessionToken)` at the write.
- Why: `check-session-token-hashed.mjs` resolves a `data.sessionToken` value only within the same file (a `hashSessionToken(...)` call, or a local binding to one). A digest passed in from the caller is unprovable to the gate. Measured on a scratch copy: `sessionToken: input.sessionTokenDigest` fails the gate, and `hashSessionToken(input.sessionToken)` passes. Hashing next to the write also matches every other Session write in the adapter.
- Effect on tests: C1 integration cases pick raw tokens and compute the digests they look for with `hashSessionToken`. The F2-test-1 absence check is unchanged in substance.

## D2 — `extension/token/exchange/route.test.ts` updated (side-fix)
- Not in the Testing strategy file list, but it is in the Implementation Checklist's `issueExtensionToken` test tree. It drives the real `issueExtensionToken` against mocked Prisma, so the row-cap → family-cap change broke its eviction case. The case was rewritten as a family-cap eviction.

## D3 — Orchestrator corrections after batch B
- The presence reads inside `enforceActiveFamilyCap` run sequentially instead of through `Promise.all` on one interactive transaction.
- `issueExtensionToken` emits eviction audits before its post-commit `cnfJkt` invariant check, so a throw there cannot drop the audit of already-committed evictions.
- The stale AutoFill comment ("stays within the active cap") was rewritten.

## D4 — `auth-adapter.test.ts` not modified
- The plan expected a seam change. All 66 existing cases pass unchanged against the delegating `createSession`. The ordering is pinned in the new `session-concurrency.test.ts` (unit, asserts `orderBy`) and in the integration ordering case instead.

## D5 — C2 unit test does not assert "`invalidateUserSessions` never called"
- The route no longer imports that module, so mocking it and asserting zero calls would pass regardless of behaviour (decorative, RT7).
- The invariant is pinned non-vacuously in two ways. The route test's Prisma mock has no `session` model, so any direct `tx.session.*` call throws. The real-DB C2 case asserts that the extension family, the iOS family and the second Web session all survive.

## D6 — Step 2-5 self-R-check: AutoFill concurrency test gained its RT4 lower bound
- The security and testing self-checks both flagged case (h): it asserted only "exactly one active AutoFill row", which a run where the mints never contended also satisfies.
- It now asserts first that all N rows were created and N-1 were revoked, then that 1 is active.
- Red proof: a throwaway copy with `advisoryXactLock` mocked to a no-op fails with "expected 2 to be 9". The copy was deleted.
- Self-check result: the functionality check had no findings. Security and testing each had this one RT4 finding and nothing else fired. Minor note (not firing): the `sessions/route.test.ts` reason mock omits `PRESENCE_EXPIRED`, but that route reads only `SIGN_OUT_EVERYWHERE`.
