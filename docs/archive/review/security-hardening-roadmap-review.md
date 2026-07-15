# Plan Review: Security Hardening Roadmap (P1–P4)
Date: 2026-07-15
Review round: 1

## Changes from Previous Round
Initial review. Plan reviewed as a roadmap (four future PR series), with a
pre-verified Ground-truth reconciliation section. Three experts reviewed against
the real repo state, not the roadmap's original (partly-wrong) prose.

## Summary of severities
- Critical: 4 (C1 npm-provenance/theater, X1 iOS-guard-self-test isolation, X2 P4 fixture taxonomy vacuity, X3 P3 expiry-check wrong-cert silent-pass)
- Major: 9
- Minor: 6

---

## Merged Findings (deduplicated across experts)

### CRITICAL

**C1 — P1: npm already emits provenance for free; cosign is the wrong primitive; no verifier = signing theater.** (Security C1, escalated; corroborated by Testing #8)
- The CLI publishes via npm OIDC Trusted Publishing but does **not** pass `--provenance` / `publishConfig.provenance` — so today it ships with *no* provenance despite being one flag from npm-native SLSA provenance. The plan bundles "cosign + attest-build-provenance" without saying which artifact each covers; cosign is an OCI-image primitive and (per SC1/GT-P1-d) **no image exists**. The testing-strategy line "verification must run in CI and at deploy" names **no verifier** for the npm package (`npm audit signatures` is never run).
- Action: split C-P1 provenance into (1) npm CLI → enable `--provenance` + a `npm audit signatures` verifier in CI (the ship-today win); (2) container/blob → `attest-build-provenance`/cosign behind SC1. Every signature gets a named verifier or it is theater. Sequence producer-before-consumer (Testing #8): the verification test must consume a genuinely-signed artifact (VC2: CI-only).

**X1 — P4: iOS guard self-test isolation needs a DUAL root override (scan root + allowlist-resolution root), plus a seeded `ServerTrustService.swift`.** (Functionality F6 + Security m2 + Testing #1 — 3-way convergence)
- `check-ios-authenticated-session-pinning.sh` has two coupled filesystem dependencies: it greps three hardcoded named subdirs (`PasswdSSOApp`/`Shared`/`PasswdSSOAutofillExtension`) AND validates the allowlist against real files (`$IOS_DIR/$entry`, lines 85–96). A single `CTC_CHECK_ROOT`-style override is necessary but not sufficient — unless the fixture tree also reproduces the 3-subdir layout and seeds `Shared/Network/ServerTrustService.swift`, the "stale allowlist" clause fires and every case fails for the wrong reason (false-red masking whether the URLSession scan works).
- Security add-on (m2): the override must fail **closed** — CI pins the root to the real `ios/`; a root pointing outside the repo must be rejected, or a malicious PR points the guard at an empty dir and passes trivially.
- Action: C-P4 must thread the override through grep-root + `rel`-strip base + allowlist-existence base together; seed a stub `ServerTrustService.swift`; add a positive-passes case proving the harness isn't spuriously red before asserting negatives.

**X2 — P4: the fixed 4-fixture taxonomy (positive/negative/stale/false-positive) is vacuous for this trivial-regex guard (RT7).** (Functionality F7 + Testing #2; Functionality escalation from Major)
- The count-then-create guard warrants 9 cases because it has 6+ distinct code-shape branches. The iOS guard is a blanket substring ban (`URLSession\(|URLSession\.init\(|URLSession\.shared`) with one allowlist entry. "stale" has no meaning for a blanket ban (no per-target rule to go stale) — forcing it produces a fixture that can't distinguish a working guard from a broken one. Meanwhile the *genuinely valuable* case — a `// URLSession(` comment/string in a production file, which the current guard gets **wrong** (no comment-blanking) — risks being omitted because the taxonomy slot is "filled."
- Action: derive fixtures from the guard's **actual branches**, not a template: {allowlisted-constructs→pass, non-allowlisted-constructs→fail, construction-in-comment/string→(fix guard or pin known-FP), test-target-path→pass, allowlist-stale→fail}. Case count follows branches.

**X3 — P3: `openssl pkcs12 -nokeys | openssl x509 -checkend` reads only the FIRST cert; order is not pinned → silent CA-check no-op.** (Functionality F1)
- `-nokeys` emits leaf **then** CA; `openssl x509` consumes only the first. Today the leaf is first *by emission order* (an implementation detail). If a future openssl / regenerated fixture reverses it, the check silently validates the CA (`notAfter 2126`) and can **never fail** — the exact silent-pass P3 exists to prevent.
- Action: select the leaf explicitly — add `-clcerts` to `openssl pkcs12` (client/leaf only, excludes the CA chain), or extract to a temp file and pick by subject. Do not rely on pipe order.

### MAJOR

**M-a — P3: `-legacy` is unavailable on macOS runners (LibreSSL), and the pipe needs `set -o pipefail`.** (Functionality F2 — R16 + R44; Testing #3 corroborates)
- The committed `.p12` is `-legacy`-encrypted. ubuntu-latest (OpenSSL 3.x) accepts `-legacy`; **macos-latest ships LibreSSL** which rejects it. If the check is sited on the iOS/macOS job (natural, next to the fixtures) it breaks. The two-stage pipe's exit is the last command's — a stage-1 failure (wrong pass, missing `-legacy`, empty stream) can false-pass without `pipefail`.
- Action: pin the expiry check to an ubuntu (OpenSSL 3.x) job; mandate `set -euo pipefail`; distinguish valid / expired / unreadable-or-extraction-failed as **separate** exit paths (don't collapse extraction failure into pipefail).

**M-b — P3: no negative self-test; the check is vacuous as described (RT7).** (Testing #3)
- A check that passes when the cert is fine and errors ambiguously when input is unreadable cannot distinguish "fixture healthy" from "extraction command broken." The monthly workflow could go green for a year checking nothing.
- Action: require a deterministically-expired fixture (`openssl ... -days -1`, already-expired at creation — no clock-freezing) that the check MUST reject via the *asserted expired-branch*, plus a healthy-passes assertion. Assert the reason, not just exit code.

**M-c — P2: regression gate not bound to the existing audit-outbox integration suite; and the idempotency test must actually RACE (RT4).** (Functionality F4 + Testing #4 — convergence)
- GT-P2-b flags refactor risk to a security-audit-critical path but names no gate. The existing dedup test is **serialized** (`claim→deliver→reset→claim→deliver`) — it proves `ON CONFLICT DO NOTHING` de-dupes sequentially, NOT that two concurrent workers can't both insert. The repo already has the right pattern (`audit-outbox-skip-locked.integration.test.ts`, barrier-synchronized `Promise.all`).
- Action: C-P2 must (1) model the new `WorkerExecution` idempotency-claim test on the barrier `Promise.all` concurrent pattern (assert exactly one row under *simultaneous* claims); (2) name `src/__tests__/db-integration/audit-outbox-*.integration.test.ts` + `retention-gc-*` as the explicit unchanged-green regression gate (`test:integration`, real Postgres — the R32 boot/behavior smoke).

**M-d — P2: the manifest-mechanization + destructive-cap work spans 4 workers, and the destructive-cap gap is REAL (contradicting GT-P2-b framing).** (Functionality F3 — R42)
- The manifest already governs 4 workers (audit-outbox, retention-gc, audit-anchor-publisher, audit-chain-verify). More importantly: in `audit-outbox-worker.ts` the **claim** paths are `LIMIT`-bounded but the **destructive** paths are NOT — `purgeRetention` (`DELETE FROM audit_outbox`, `DELETE FROM audit_deliveries`) and `reapStuckRows`/`reapStuckDeliveries` have no LIMIT. So "destructive batch cap" *is* a genuinely missing capability, not "already ad hoc." GT-P2-b undersells this.
- Action: state the 4-worker member-set for the mechanization sub-task; correct GT-P2-b — the uncapped destructive surface is purge/reap, and that cap is net-new work.

**M-e — P2: `WorkerExecution` idempotency table duplicates the existing `ON CONFLICT (outbox_id) DO NOTHING` + `SKIP LOCKED`; composition unspecified.** (Functionality F5; Security A2 adds the tenant-safety constraint)
- Audit-outbox already enforces claim-once (`FOR UPDATE SKIP LOCKED`) and deliver-once (`ON CONFLICT (outbox_id) DO NOTHING`). A generic `WorkerExecution` table adds a third layer — redundant if in front, a behavior change if it replaces.
- Action: C-P2 must state, per worker, whether `WorkerExecution` is sole idempotency key or a wrapper; for audit-outbox the existing `ON CONFLICT` stays authoritative and `WorkerExecution` guards only non-idempotent side-effects (fan-out/webhook). **Schema constraint (Security A2): the key must be tenant-partitioned or opaque (random UUID/hash), never a global monotonic counter; the table must be RLS-scoped or worker-role-only** — else it's a cross-tenant enumeration/timing surface.

**M-f — P2: the audit-chain integrity invariant the refactor can silently break is not named.** (Security M3)
- Dead-letter/reaper events are written via `writeDirectAuditLog`, deliberately bypassing the outbox AND the hash chain (no `chain_seq`); the verifier filters `WHERE chain_seq IS NOT NULL` so they're legitimately unchained. A naive `runWorkerJob` consolidation that routes dead-letter emission back through the normal enqueue path would either recurse infinitely or start chaining dead-letter events, breaking `firstTamperedSeq` semantics.
- Action: C-P2 contract clause — "dead-letter/reaper/retention-purge audit events MUST stay unchained (`chain_seq IS NULL`) and bypass the outbox; `runWorkerJob` idempotency MUST NOT wrap `writeDirectAuditLog`." Regression test: assert `AUDIT_OUTBOX_DEAD_LETTER` rows have `chain_seq IS NULL`.

**M-g — P2: poison-message replay is a new cross-tenant audit-write privilege with no authz model.** (Security M4)
- Re-injecting a dead-lettered audit event is a write to the tamper-evident audit_logs of an arbitrary tenant. "operator-gated + audited" is stated but the gate is undefined (which credential class, per-tenant vs system-wide, re-chain vs unchained).
- Action: C-P2 — replay is a distinct operator scope (not a reused broad admin token), emits its own SYSTEM-actor audit event (who replayed which outbox_id), is idempotent against the `WorkerExecution` key, and follows the M-f unchained rule.

**M-h — P1: dependency auto-merge of "security patch/minor with passing tests" is an RS5 fail-open supply-chain path.** (Security M1)
- Tests do not detect a supply-chain payload (event-stream/ua-parser-js/xz pattern — all patch/minor that pass tests). Auto-merge into `main` of a password-manager treats an untrusted upstream version bump as trusted.
- Action: do not auto-merge into `main`; require human approval, or gate behind (a) a cooldown/quarantine window (defeats publish-and-yank), (b) provenance check where available, (c) hard block for any crypto/auth allowlist package (M-i). Classify auto-merge as fail-open in the per-PR threat model.

**M-i — P1: the crypto/auth "stricter review" package list is guessed, not derived (R42).** (Security M2)
- Action: derive by grepping imports in `src/lib/crypto/**`, `src/lib/auth/**`, `auth.ts`, WebAuthn/SAML routes (`@simplewebauthn/*`, `@auth/*`/`next-auth`, `@boxyhq/saml-jackson` deps, `@prisma/adapter-pg`+`pg`, argon2/KDF, `jose`); pin in a CI-checked manifest, regenerate on `package.json` change.

**M-j — P1: signature-verification is untestable until a producer lands; require producer-first sequencing.** (Testing #8, [Adjacent])
- Action: C-P1 states producer-before-consumer explicitly; the verification test consumes a genuinely-signed artifact (VC2: keyless OIDC signing is CI-only → this test is `verifiable-CI`, never local).

**M-k — P4: the fixture-count manifest rewards decorative fixtures; use red-case + presence gates instead.** (Testing #5 — R42)
- Counting is a proxy metric satisfied by N decorative fixtures. Better: (a) every guard self-test must contain ≥1 asserted-RED case (`expect(code).toBe(1)` with the specific error identifier) — grep-mechanizable; (b) presence gate: every `scripts/checks/*.{sh,mjs}` maps to a `scripts/__tests__/*` file or a documented exemption (worker-manifest completeness pattern).

**M-l — P4: exit-code-only assertion conflates the iOS guard's 3 fail branches; introduce stable error identifiers (RT8).** (Testing #6; Functionality corroborates via X1)
- `exit 1` conflates URLSession-violation / allowlist-missing-file / allowlist-stale. A self-test asserting only exit-code can pass because the wrong clause fired (ties to X1).
- Action: emit stable identifiers (`UNPINNED_URLSESSION_CONSTRUCTION`, `ALLOWLIST_MISSING_FILE`, `ALLOWLIST_STALE_ENTRY`) alongside prose; self-tests assert the identifier (the test contract), treat prose as advisory. Document identifiers as a breaking-change surface.

### MINOR

**m-1 — P3: the "2027-08-15 stale guess" is numerically correct for the committed fixture (expires exactly `Aug 15 2027`).** (Functionality F8) Reword GT-P3-b to "correct today, must not be hardcoded — it moves every regeneration."

**m-2 — P3: cron + PR-CI split is non-redundant but should use different `-checkend` windows.** (Functionality F9) CI = already-expired/short horizon (block a PR shipping dead fixtures); cron = look-ahead 30–45 days (warn before lapse). They cover disjoint triggers.

**m-3 — P3: `-passin pass:<literal>` leaks the passphrase to the process list — a pattern hazard.** (Security M5, RS6) The passphrase is intentionally public (test-only, SAN=localhost, CA:FALSE — verified), so no live secret leak, but this becomes the repo's canonical "how we read a p12." Use `-passin env:P12_PASS` and comment that `pass:` on argv is banned for non-public passphrases.

**m-4 — P1: "deploy by digest not tag" has no applicable target.** (Functionality F10, R41) The only publish is npm (already content-addressed); no deploy step exists; container path is deferred by SC1. Drop it or move under SC1.

**m-5 — P1: Actions boundary omits `workflow_run`, fork-PR secret exposure, self-hosted runners; and several controls are preventive not fixes.** (Security m1) No `pull_request_target` exists today (so the ban is a *preventive guard*); per-workflow `permissions` are already scoped. Fold `workflow_run` into the same guard as `pull_request_target`; confirm `ci-integration.yml` (needs `SHARE_MASTER_KEY`) doesn't run on fork PRs with secrets.

**m-6 — P3/P4: the shell/openssl/grep self-tests are Linux-runnable, not macOS-only (VC1).** (Testing #9) Only the XCTest real-TLS consumption is macOS-CI-only. Split: expiry-check self-test + iOS pinning-**guard** self-test run on the Linux static-checks/pre-PR job (developers can run them locally); only real-TLS XCTest is VC1.

**m-7 — P4: "guard changed but no test changed → warn" (git-diff coupling) is flaky.** (Testing #7) False-positives on comment/format/rename, false-negatives on shared-helper changes. Prefer the M-k structural gate; if kept, scope to non-comment/non-rename hunks and keep advisory.

**m-8 — Sequencing P3→P4→P2→P1 is sound.** (Functionality F11) No hard dependency forces reorder. Soft reinforcement: P4's self-test harness (env-root override, red-case idiom) is the reusable template for P1's future Actions-boundary guards — doing P4 first means P1's new guards inherit a proven self-test idiom.

---

## Adjacent Findings (routing)
- Functionality F4 → Testing (merged into M-c).
- Functionality F7 → Testing (merged into X2).
- Security A1 (P4 negative fixture must prove guard can FAIL, RT7) → Testing (merged into X2/M-l).
- Security A2 (WorkerExecution key tenant-partitioned/opaque/RLS) → Functionality data-model (merged into M-e).
- Testing #8 (P1 verification producer-first) → Functionality/Security (merged into C1/M-j).

## Quality Warnings
None — all findings carry concrete file/line evidence and verified repro. No VAGUE / NO-EVIDENCE / UNTESTED-CLAIM flags.

---

## Recurring Issue Check

### Functionality expert
R1 pass · R2 pass · R3 FINDING (F3/F6) · R4–R15 n/a · R16 FINDING (F2, LibreSSL -legacy) · R17–R28 n/a · R29 pass (398-day cap / SecTrust -67901 verified in generator) · R30 n/a · R31 n/a · R32 FINDING (F4, integration suite not bound) · R33–R40 n/a · R41 FINDING (F10, deploy-by-digest dangles; containers correctly deferred) · R42 FINDING (F3 workers=4, F7 guard fixture-set) · R43 n/a · R44 FINDING (F1 wrong-cert, F2 pipefail)

### Security expert
R1–R28 ok · R29 flag (C1, npm-native vs cosign conflated, no spec cited) · R30–R41 ok · R42 flag (M2 crypto/auth list guessed; worker-set correctly derived) · R43 ok · R44 ok · RS1 ok · RS2 ok · RS3 flag (M4 replay + WorkerExecution key lack authz/validation spec) · RS4 ok (p12 passphrase intentionally public, non-production, verified) · RS5 flag (M1 dependency auto-merge fail-open) · RS6 flag (M5 `pass:` argv leak)

### Testing expert
R1–R41 ok · R42 flag (F5 count-manifest ≠ branch-coverage) · R43 ok · R44 ok · RT1 ok · RT2 ok · RT3 ok · RT4 flag (F4 serialized dedup ≠ race) · RT5 flag (F8 P1 verification would assert against mock) · RT6 ok · RT7 flag (F2 vacuous stale fixture; F3 expiry-check can't be shown to fail) · RT8 flag (F6 exit-code-only conflates 3 branches) · RT9 ok (no parallel-impl twin introduced)
