# Plan Review: extension-prf-vault-autounlock
Date: 2026-06-28
Review round: 1

## Changes from Previous Round
Initial review (3 expert agents: functionality / security / testing).

## Verdict: NO-GO as written — all three experts independently rejected the plan.

Two blocking classes:
1. **Security (S1/S2, escalate:true)** — the recipient ECDH pubkey crosses an unauthenticated page-trusted relay with a *self-derived* (circular) `recipientJkt` binding. A page-XSS during ext_connect can seal the real vault key to an attacker ECDH key and exfiltrate inert ciphertext. The feature's entire value is the trust boundary; as designed it ADDS a page-XSS-during-connect exfiltration window. Requires authenticating the SW ECDH recipient key to the connection's DPoP `cnf.jkt` (DPoP-signed ECDH key, or co-derivation). **This is a design decision, not a wording fix.**
2. **Functionality (F1) + Testing (T3)** — the return channel (page→CS→SW second message + ecdhPublicJwk threading) does NOT exist; the relay is request/response only. Must be built. F3 — the team-escrow primitives cannot emit the new AAD; need dedicated wrap/unwrap. F6 — the C15-v2 activation gate as specified would silently drop the envelope in the happy path.

## Functionality Findings
(see full list) F1 Critical (return channel missing), F3/F4/F5/F6 Major, F2 Major (wrong AAD module), F7-F10 Minor.

## Security Findings
S1 Critical (escalate) — page-XSS exfiltration via unsigned recipient key + materialized plaintext.
S2 Critical (escalate) — recipientJkt circular, no recipient authentication.
S3 Major — NFR1/NFR3 (no-plaintext-off-SW, zeroize) already false: currentVaultSecretKeyHex is an immortal string written to chrome.storage.session.
S4-S6 Minor; S7 confirmed OK (server oblivious).
AAD: must use a NEW 2-char SCOPE byte (not a data field). ECDH IDB record must rotate with DPoP/connection.

## Testing Findings
T1 Critical — C5 negative tests vacuous (background.test.ts mocks all crypto). T3/T4/T5/T6/T11 Major. T2/T7/T8/T9/T10 Minor. C8 must be a committed golden-vector fixture across two tests. Parallel-impl must use the automated js-sync test, not a manual diff.

## Key cross-cutting consensus
- The recipient-key authentication gap (S1/S2) is THE blocker — without binding the ECDH recipient to the DPoP cnf.jkt, 方式A is worse than the passphrase prompt it replaces.
- S7: server obliviousness is the strong part; preserve it (do NOT adopt SC1 server-escrow).
- AAD must use the scope-byte registry (new "EV" scope), not a string field — affects C8 fixture.
- F3: reuse the ECDH derivation primitive, not the team-AAD-bound wrap function.
