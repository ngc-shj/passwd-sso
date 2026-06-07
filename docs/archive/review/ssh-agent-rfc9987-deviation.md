# Coding Deviation Log: ssh-agent-rfc9987

## C6 — DER long-form length fix (correctness, within contract)
`sshEcdsaToDer` (CLI `ssh-session-bind.ts`) initially emitted single-byte DER lengths,
which produces invalid DER for ECDSA P-521 (SEQUENCE length > 127). Fixed to emit
definite long-form lengths; added an `ecdsa-sha2-nistp521` synthetic test vector that
exercises the long-form path. Found during orchestrator R21 spot-check of the net-new crypto.

## C2 — CLI_SCOPES completeness
Neither Batch A nor Batch C initially added `ssh:sign` to `cli/src/lib/oauth.ts` `CLI_SCOPES`
(batch boundary gap). Added by the orchestrator. Without it the agent's token would lack the
scope and fail-closed on every sign (R1 F6).

## C6 — captured ed25519 golden vector descoped to manual test (Phase 3 T1/S2)
- **Anti-Deferral check**: blocked-deferred, tied to Phase 1 constraint **VC1** (real OpenSSH handshake).
- **Justification**: C6 acceptance locked "one captured real ed25519 session-bind frame committed as a fixture + flip-byte". The implementation ships **synthetic** vectors only (ed25519/rsa-sha2-256/512/ecdsa-nistp256/nistp521 + algo-mismatch + unsupported-type), each with flip-byte→false negative cases that exercise the real `node:crypto` verify primitives (a stub verifier fails them). Capturing a real frame requires a live `ssh` handshake against the agent socket — **VC1, classified blocked-deferred in Phase 1**. Residual gap: cross-implementation byte-framing parity with real OpenSSH. Mitigation: (a) the test's wire encoders (`buildSshSig`/`buildEcdsaPubBlob`/`derEcdsaToSsh`) are INDEPENDENT hand-written implementations from the production parser (`parseSessionBind`/`sshWirePublicKeyToKeyObject`/`sshEcdsaToDer`), so a systematic co-bug is unlikely; (b) the VC1 manual-test step (`docs/archive/review/ssh-agent-rfc9987-manual-test.md` §1) verifies a real `ssh -T` handshake end-to-end. Worst case: a framing divergence from real OpenSSH that both the production parser and the test encoder share — caught by the manual test before release. Likelihood: low (independent impls). Cost to capture now: ~30 min live-ssh, environment-blocked in this session.
- **Orchestrator sign-off**: descope is honest (synthetic vectors are not relabeled as captured), tied to the predicted VC1 constraint, and the manual test covers the residual. Acceptable for v1.

## C7 — `_resetScopeHintForTest` export (test seam, beyond contract)
`ssh-sign-authorizer.ts` exports a `_resetScopeHintForTest()` helper so the once-per-process
re-login hint guard can be reset between unit tests. Minor test-only addition; not a behavior change.

## R2 (hardcoded-reuse) — `"passwd-sso"` socket dir literal — NOT fixed (recorded)
- **Anti-Deferral check**: out of scope (different concern / cross-cutting refactor).
- **Justification**: `ssh-agent-socket.ts` builds the runtime socket dir as `join(xdg, "passwd-sso")`.
  The check flags this against `APP_NAME` in `cli/src/lib/paths.ts:12`, but `APP_NAME` is a
  PRIVATE (non-exported) const, the literal is PRE-EXISTING (present in `main` at line 32), and the
  sibling decrypt agent (`agent-decrypt.ts`) hardcodes the same pattern. A proper fix is to export a
  shared `getRuntimeSocketDir()` helper and migrate BOTH agents — a cross-cutting refactor beyond this
  PR (>30 min done correctly, touches an unrelated command). Tracked for a future cleanup PR.
- **Orchestrator sign-off**: pre-existing, consistent across both CLI agents; deferring does not
  regress behavior. The other check-hardcoded-reuse hits (`"P-256"` standard Web Crypto curve id;
  `"user-1"`/`"tenant-1"`/`"sa-1"` per-test-file local IDs) are heuristic false positives — those
  constants are file-local in unrelated test files, not shared exports.
