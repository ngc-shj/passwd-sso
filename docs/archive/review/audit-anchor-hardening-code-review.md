# Code Review: audit-anchor-hardening
Date: 2026-11-15
Review round: 1

## Changes from Previous Round

Initial review, on top of the Phase 2 self-R-check (deviation log, "Step 2-5"). Local-LLM
pre-screening and seeds unavailable (Ollama down): each expert did a full-diff review.
No Critical. IDs are the experts' own, prefixed `F-` functionality, `S-` security, `T-` testing.

## Functionality Findings

| ID | Sev | Finding |
|----|-----|---------|
| F-1 | Major | `audit-anchor-publish-pubkey` byte-compared the archived key and refused one archived by the previous runbook (64 bytes, no newline); on the Terraform bucket that object can never be replaced |
| F-2 | Minor | The key scripts refused an upper-case hex seed the env schema and publisher accept |
| F-3 | Minor | A failure after the primary create but before the commit path was reported as stage `before_upload` |
| F-4 | Minor | A publish covering no anchor row never settled; restarts re-adopted up to the alarmed cap (a regression from `main`, where the marker made them skip) |
| F-5 | Minor | The manual-test record missed fenced runbook commands and had no blob id (same as T-1) |
| F-6 | Minor | A checklist file is not in the diff, unlogged (same as S-9, T-10a) |
| F-7 | Minor (adjacent) | CLI `InvalidKidError` printed the unverified `kid` raw (same as S-3) |

## Security Findings

| ID | Sev | Finding |
|----|-----|---------|
| S-1 | Major | An adopted publish emitted no `TENANT_DROPPED_FROM_MANIFEST` / `CHAIN_SEQ_REGRESSION`, and a database writer can force the adopt (hold a row lock so the commit fails after the create) |
| S-2 | Minor | A changed `epoch` silenced `CHAIN_SEQ_REGRESSION`; nothing legitimate writes `epoch` |
| S-3 | Minor | CLI `InvalidKidError` printed the unverified header `kid` raw |
| S-4 | Minor | CLI manifest and archive fetches had no size bound and no timeout |
| S-5 | Minor | `FilesystemDestination.read` was bounded by `stat` only and followed entries `list` hides (a symlink to a device) |
| S-6 | Minor | `unrecognised_manifest_key` logged one line per key per listing, unbounded |
| S-7 | Minor (question) | A manifest is not bound to its location: after a chain restart a copied old-chain manifest is adopted or chained to |
| S-8 | Minor | The verification guide said exit 0 proves continuity; the CLI exits 0 with a WARN on a genesis manifest |
| S-9 | Minor (adjacent) | Checklist file not in the diff |

Attacked and held (security expert): no database-write combination yields a healthy skip, a
redirected `previousManifest` or an adoption of an object the own key did not sign; the
GitHub token is not forwarded on a cross-origin redirect (executed); no seed reaches argv,
stdout or stderr; every failure reason reaching `audit_logs.metadata` is a token.

## Testing Findings

| ID | Sev | Finding |
|----|-----|---------|
| T-1 | Major | The manual-test record missed four runbook commands and one SQL block, recorded no blob id, and one deferral named no constraint |
| T-2 | Major | The fake GitHub server answered an asset download with a direct 200 only; the documented 302 was not modelled and the belief not declared |
| T-3 | Minor | Two pre-existing publish-path guards stayed green when removed (`!uploaded && isLockNotAvailable`, `persistPause`'s guard) |
| T-4 | Minor | The CLI's `redirect: "manual"` refusal had no test |
| T-5 | Minor | `ci-integration.yml`'s filter missed `src/__tests__/helpers/**` and `docs/operations/alerts.md` |
| T-6 | Minor | A stale `DESTINATION_DIVERGENCE` `it.todo` pointed at a removed test and API |
| T-7 | Minor | The attempt cap and a duration were still literals in tests |
| T-8 | Minor | The scripts' env-to-destination wiring had no automated test |
| T-9 | Minor | CLI exit-code tests skip silently when `cli/dist` is absent |
| T-10 | Minor | (a) checklist file unlogged; (b) overlap cases could time out instead of reporting |

The testing expert re-verified by mutation (scratch copies) that every fix of the Step 2-5
self-check has a test that reddens when its guard is removed — closing the gap the deviation
log recorded there.

## Adjacent Findings

F-7 → Security (S-3). S-9 → Testing (T-10a). Convergence: S-3/F-7; F-5/T-1; F-6/S-9/T-10a.

## Quality Warnings

None (merged by hand; every finding carried file:line evidence).

## Recurring Issue Check

### Functionality expert
R48 F-1, F-2, F-7; R29 F-3 (stage definition); R56 F-4. Checked OK: R1, R3, R4, R5/R9, R10,
R14, R16, R17, R20, R22, R25, R27, R31, R32/R35 (record gap F-5), R33, R36, R38, R40, R41,
R42, R51, R52, R54, R55, R57. Not re-derived (other scopes): R18, R19, R21, R49. N/A: the rest.

### Security expert
R3 S-3; R4 S-1; R29 S-8; R34 S-3, S-4, S-8 (pre-existing in changed files, reported); R45 S-6;
R48 S-5; R49 S-1, S-8 (S-2, S-7 residuals the docs did not state); RS3 S-4; RS6 S-3. Checked
OK: R1, R2, R5, R9, R10, R12, R14, R16, R17, R18, R31, R32, R33, R35, R36, R38, R40, R41, R42
(verify callers re-derived), R43, R47, R51, R52, R54, R55, R56, R57, RS4, RS5. N/A: R6–R8, R11,
R13, R15, R19, R20, R22–R28, R30, R37, R44, R46, R50, R53, RS1, RS2.

### Testing expert
R29 T-6, T-7; R33 T-5; R34 T-3, T-4; R35 T-1; R49 T-2; R50 T-1, T-9; RT1 T-2; RT3 T-7; RT6
T-8; RT7 T-3, T-4. Pass: R1, R2, R3, R14, R16, R19, R21 (self-check fixes mutation-verified),
R31, R32, R36, R38, R41, R42, R44, R47, R48, R54, R56, R57, RT2, RT4, RT5, RT8, RT9, RT10,
RT11. N/A: the rest.

## Environment Verification Report

| Path | Class | Evidence |
|------|-------|----------|
| C1 create-only on S3 (412, one version, 8 concurrent) | verified-local | `audit-anchor-s3-destination.integration.test.ts` on MinIO; plan probe |
| C1 S3 `409 ConditionalRequestConflict` | blocked-deferred | E1 — unit-tested on a fabricated status; worst case: a 409 storm fails the run (`_UPLOAD_FAILED`), retried |
| C1 GitHub asset semantics (422, reservation states, 302 download) | blocked-deferred | E2 — fake server (now with the 302); assumptions listed in the fake's header; worst case: row a / `_UPLOAD_FAILED` on a GitHub destination, alarmed |
| C4 run protocol, decision table, adoption, rotation | verified-local | anchor integration set (7 files, 98 passed) on Postgres + MinIO; built bundle in the manual test |
| C5 IAM read grant on real AWS | blocked-deferred | E1 — static tests + `terraform validate` in CI; worst case: `s3-object-lock_READ_FAILED:AccessDenied` on every run, alarmed within one cadence |
| C7 scripts | verified-local | unit + spawn tests; manual test section 2 on MinIO |
| C8 runbook `aws …` / `terraform …` lines | blocked-deferred | E1, SC6 — manual-test record rows; worst case: an operator command errors during a rotation, nothing is published wrongly |
| Two publisher hosts / ECS deploy | blocked-deferred | E3 — two instances in one process (both integration overlap cases); worst case covered by create-only + the advisory lock |

Anti-Deferral justifications for the `blocked-deferred` rows are in the plan (C5 "Verification",
SC1, SC5, SC6) and the manual-test record.

## Resolution Status

### S-1 Major — adopted publish emitted no drop/regression rows
- Action: on an adopted publish the previous manifest named by `previousManifest.uri` is read
  back (inside the run's bound, after the commit), its hash is required to equal
  `previousManifest.sha256`, and the rows are computed against it;
  `PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON` when it is missing, unverifiable or differs
  (plus a `previous_manifest_unavailable` warn line). Genesis adopt emits neither.
- Red proofs: comparison dropped → 9 unit + the integration case red; hash equality dropped →
  1 red; unavailable branch dropped → 4 red.
- Modified: `src/workers/audit-anchor-publisher.ts` (`previousOfAdopted`, `publishedEmits`),
  tests, `alerts.md`, runbook, threat model, `worker-policy-manifest.json`; plan C4 and T3-5
  updated (the plan had said "not on an adopted publish").

### F-1 Major — publish-pubkey refused a key archived without a newline
- Action: the public-key artifact is "the same" when its parsed key equals the one being
  archived (`exists (same key)`, zero creates); another key or unparseable content → exit 1,
  zero creates anywhere; statements keep the byte compare.
- Red proofs: byte compare restored → 2 red; parse dropped → 6 red; skip-create dropped → 2 red.
- Modified: `scripts/audit-anchor-keys.ts`, its test.

### T-2 Major — fake GitHub server modelled only the direct 200
- Action: a download answers 302 to a second listener by default (one direct-200 case kept);
  the test asserts the bytes and that the second listener receives no `Authorization`; the
  fake's header lists what it still cannot verify.
- Red proof: `redirect: "manual"` on the destination's download → the 302 case red, the 200 green.
- Modified: `src/__tests__/helpers/fake-github-release-server.ts`,
  `audit-anchor-github-release-destination.integration.test.ts`.

### T-1 / F-5 Major — manual-test record incomplete
- Action: the record names the runbook blob, extracts every `bash`/`sql` fence line and inline
  `npm run` span (with the count), and adds the missing rows: the tag-secret generator, the
  DEPLOYMENT_ID SQL with and without the bypass GUCs, the audit-rows read, the local half of
  the Secrets Manager step, and `blocked-deferred (E1)` rows for `terraform output` and
  `aws secretsmanager`.
- Modified: `docs/archive/review/audit-anchor-hardening-manual-test.md`.

### Minor findings — all fixed
- S-2: `EPOCH_CHANGED { count }` row (either direction, fresh and adopted); CLI WARN.
- S-3 / F-7: CLI `InvalidKidError` uses `JSON.stringify`; control-character vector on both sides.
- S-4: CLI fetches have a 30 s timeout and the 8 MiB bound (Content-Length and counted body).
- S-5: filesystem `read` opens with `O_NOFOLLOW`, requires a regular file
  (`ARTIFACT_NOT_REGULAR_FILE`), reads at most bound + 1 bytes.
- S-6: one `unrecognised_manifest_key` line per listing (count + first 5 keys).
- S-7: accepted as a stated limit, documented — see the entry below.
- S-8: the verification guide says what the genesis WARN means.
- F-2: seeds accept either hex case; public keys stay strict.
- F-3: a failure once the primary holds the object is stage `upload`.
- F-4: the run's tenant set is the chain-enabled tenants that have an anchor row; none → the
  no-tenant path (see deviation D45 for what the `chain-enabled-fell-to-zero` alarm sees).
- F-6 / S-9 / T-10a: deviation D44.
- T-3: tests for both guards (55P03 after the create → `COMMIT_FAILED_AFTER_UPLOAD`; a row
  published at or after the failure clock is not paused).
- T-4: redirect-refusal test for manifest and key, with the 200 twin.
- T-5: `ci-integration.yml` filter entries, pinned by a test.
- T-6: stale todo removed. T-7: tests derive from `AUDIT_ANCHOR_UPLOAD_ATTEMPT_CAP`.
- T-8: spawn case with a filesystem destination. T-9: a CI-only case that fails when
  `dist/index.js` is missing. T-10b: overlap cases race against run A ending.

### S-7 Minor — a manifest is not bound to its location — Accepted
- **Anti-Deferral check**: acceptable risk.
- **Justification**:
  - Worst case: after a chain restart, a destination writer (the publisher role's credential
    holder on S3; anyone with write access on GitHub or the filesystem) copies an authentic
    manifest of the abandoned chain into the new location; it is adopted or chained to, so the
    signed chain-restart statement no longer describes what the new location holds. No forged
    content is accepted.
  - Likelihood: low — it needs write access to the destination during an incident restart,
    which on the Terraform bucket means the publisher role's credentials (rotated first by the
    runbook).
  - Cost to fix: a manifest-format change (a location/chain field signed into every manifest,
    checked by `isOurs` and row j) plus the verifier twin — a schema version bump, beyond this
    change.
- Mitigation shipped: the runbook's restart section and the threat model's stated limits say
  the first `AUDIT_ANCHOR_PUBLISHED` row after a restart must carry `genesis: true`, anything
  else is an incident. TODO(audit-anchor-hardening): bind a manifest to its chain location in a
  manifest v2.
- **Orchestrator sign-off**: acceptable-risk exception, three values stated; detection in place.

---

# Round 2
Date: 2026-11-15

## Changes from Previous Round

Incremental review of commit `74409b549` by the same three reviewers. All 26 round-1 findings
confirmed resolved (S-7 accepted; the security expert judged its Anti-Deferral entry honest
and the mitigation text present). R43 check: no predicate wider than in round 1. No Critical,
no Major. New findings (`F2-`/`S2-`/`T2-`), all Minor:

| ID | Finding | Resolution |
|----|---------|------------|
| S2-1 | A stored manifest that never reached a `published` outcome was never compared with its predecessor (hold the row lock all day: the next day chains to it and the drop is never named) | Fixed — after any `published` outcome the publisher walks back from the compared-to manifest through every manifest dated after the published high-water and compares each with the predecessor it names; rows carry `comparedArtifactKey`. Wider than the finding's one-step fix: see D51 |
| S2-2 | A FIFO at an artifact name blocked `FilesystemDestination.read` in `open` | Fixed — `O_NONBLOCK`; FIFO test with a hang-as-failure timeout |
| F2-1 | `alerts.md` said `PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON` is never expected on a no-delete store; a read error or the run's bound also writes it | Fixed — trigger and expectation reworded (alerts and runbook) |
| T2-1 | Manual-test record: count not reproducible, "two strings" note on one row only, one verifier row showed a pre-fix string | Fixed — counting command recorded, both rows noted |
| T2-2 | The step-2 anchored-tenant check stayed green when swapped for the enabled count | Fixed — new case, red-proven |
| T2-3 | `audit-anchor-kid`'s parsed-key compare untested for a key archived without a newline | Fixed — new destination in the case, red-proven |
| T2-4 | `skipped_no_tenants` with `chainEnabledTenantCount > 0` had no metric-filter scenario | Fixed — two scenarios |

Mutation spot-checks by the testing expert on the round-1 fixes: every guard reddened its
test except the two that became T2-2 and T2-3.

## Recurring Issue Check (round-2 delta)
Functionality: R29 F2-1; closed R48, R56/R38 (fresh-publish entry), R3; R43 no widening.
Security: R4/R49 S2-1; R48 S2-2 (residual of S-5); closed R3, R45, RS3, RS6; R43 no widening.
Testing: R29 T2-1; RT7 T2-2, T2-3; R19/RT1 T2-4; closed R33, R34, R35/R50, RT3, RT6.

---

# Round 3
Date: 2026-11-15

## Changes from Previous Round

Incremental review of commit `194a67e11`. All seven round-2 findings confirmed resolved; the
testing expert mutated nine guards of the walk on scratch copies and each reddened a test.
No Critical, no Major. New findings, all Minor:

| ID | Finding | Resolution |
|----|---------|------------|
| S3-1 | The unsettled-manifest walk had no length cap and ran before the mirror backfill: a nulled high-water (or a forged chain on a non-Terraform store) spent the bound on every publish, replayed historical rows and starved gap backfill | Fixed — the walk compares at most `AUDIT_ANCHOR_UNSETTLED_WALK_MAX` (7) manifests and emits one `UNSETTLED_WALK_TRUNCATED` row when cut; the backfill runs before the walk; docs name the bounded cost |
| F3-1 | The docs named only `COMMIT_FAILED_AFTER_UPLOAD` and the cap as causes of an unsettled manifest, omitting a secondary failure after the primary stored the object | Fixed — alerts and runbook |
| T3-1 | The FIFO case skipped silently when `mkfifo` cannot be spawned, including in CI | Fixed — in CI it fails with the spawn error |

Security expert's recommendation on the stated residual D52 (not required for convergence):
have the run that creates an object emit its comparison when its commit fails, so every
stored manifest is reported by its creator. Not done here — it relaxes "rows only with a
publish" and deserves its own review; recorded as a follow-up
(TODO(audit-anchor-hardening): creator-side comparison on a failed commit). The threat model
now states that the residual needs only one failed commit followed by a write to
`last_published_at`, not a lock held through every attempt.

## Recurring Issue Check (round-3 delta)
Functionality: R29 F3-1; R38/R56/R57 checked for the walk (its range is a function of the
high-water, which every `published` outcome advances). Security: R45/R49 S3-1; R4 resolved
for the unsettled case with D52 stated; R56, R57, RS3/RS6 checked. Testing: R50 T3-1; RT7
closed (all nine guards red); R29, R19/RT1 closed.

---

# Round 4
Date: 2026-11-15

## Changes from Previous Round

Confirmation round on the round-3 fix commit (`09e97ad60`), by the security expert, because
S3-1's fix changes when audit rows are written (a security-boundary edit forces a round).
Result: S3-1 resolved; **No findings**; R43 against round 3 — no predicate wider.

Observation recorded, not a finding: the walk's rows are written after the commit that
settles the new boundary, so a process killed between that commit and the second flush
leaves those manifests uncompared (they are then behind the high-water). The window existed
in round 3 and is longer by the backfill's duration; a database writer cannot cause the
kill. The creator-side comparison follow-up (D57) would close it.

## Tightening-only skip — Round 3 (functionality, testing)
Findings applied directly, no further review round for these two experts:
- [F3-1] [Minor] docs named too few causes of an unsettled manifest — `docs/operations/alerts.md`, `docs/operations/audit-anchor-rotation-runbook.md` — wording only
- [T3-1] [Minor] FIFO test skipped silently in CI — `src/lib/audit/anchor-destinations/filesystem-destination.test.ts` — test-only
Justification: both are inside round 2's fix range, inline minor (doc wording; a test's skip
condition), and touch no security boundary. The one finding that does (S3-1) got round 4.

## Termination

Code review converged in four rounds: round 4 returned no findings; no Critical or Major is
open; one Minor is Accepted with an Anti-Deferral entry (S-7, round 1 Resolution Status).
No R42 class member-set expanded during review (the verify-caller, destination and
`system_settings`-reader sets were re-derived unchanged each round), so no additional CI
guard is required for convergence.

Follow-ups recorded (to be filed with the PR): SC1 (bucket-policy `s3:if-none-match`), S-7
(bind a manifest to its chain location, manifest v2), D57 (creator-side comparison on a
failed commit).
