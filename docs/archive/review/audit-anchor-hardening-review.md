# Plan Review: audit-anchor-hardening
Date: 2026-11-14
Review round: 1

## Changes from Previous Round

Initial review of revision 1 by three fresh reviewers. Local-LLM pre-screening skipped
(Ollama unavailable). No Critical. Dispositions below are applied in revision 2.

IDs: `F-` functionality, `S-` security, `T-` testing (the experts' own numbering, prefixed).
Every finding was labelled `design` by its expert unless marked *prose*.

## Functionality Findings

| ID | Sev | Finding | Disposition (revision 2) |
|----|-----|---------|--------------------------|
| F-1 | Major | `claimAttempt` kept the `last_published_at` fallback: a database-decided skip | Fixed — `isBoundaryPublished` and `AttemptGate.already_published` deleted; forward `last_published_at` with no object is row d |
| F-2 | Major | "Settled" and adopt's write set ranged over different tenants | Fixed — adopt writes the rows whose tag is in the manifest; settled is over all anchor rows |
| F-3 | Major | GitHub 422 "exists" is a name reservation, not an object; asset naming unspecified | Fixed — only `uploaded` assets are objects; a contentless reservation is deleted and re-uploaded; key ↔ (tag, asset) functions |
| F-4 | Major | GitHub listing cost underived and unbounded | Fixed — figure derived (26 requests/listing at 7 years), break point and failure mode stated, dedicated repository documented |
| F-5 | Major | A lagging mirror was completed only within the boundary | Fixed — bounded mirror backfill on publishing runs |
| F-6 | Major | A change of primary restarted the chain silently; the cited MISSING_PRIOR row does not fire | Fixed — row d (`DESTINATION_BEHIND_DATABASE`) fails closed; seeding procedure in the runbook; false rationale removed |
| F-7 | Major | Fail-closed reasons without resets, or S3-only ones; miss caching; retry window | Fixed — reset column in the decision table; foreign-deployment same-day object is a skip (row g); misses not cached; "restart the publisher" in the runbook |
| F-8 | Major | The rotation advisory had no consumer | Fixed — statement verification procedure in the verification doc, run in the manual test; `signStatement`; exists outcomes stated |
| F-9 | Major | S3 `read` → null depended on 404-vs-403 under a conditional ListBucket | Fixed — absence is decided from the listing |
| F-10 | Minor | Under-lock re-check omitted "settled" | Fixed — the whole table is re-applied under the lock; exactly one `published` |
| F-11 | Minor | Error stages, bound span, no-tenant order, constant, key format, prior-key order | Fixed — stated in C1/C2/C4 |
| F-12 | Minor | Files describing the old protocol not listed | Fixed — C8 list, Terraform comment-only edits named |
| F-13 | Minor *prose* | Figures and claims that did not reproduce | Fixed — count dropped, grep scoped, alias added to the member set, SC6 added |

## Security Findings

| ID | Sev | Finding | Disposition (revision 2) |
|----|-----|---------|--------------------------|
| S-1 | Major | Foreign-`kid` trust is circular outside the Terraform bucket; a forged manifest could be adopted | Fixed — adoption only of objects the own key signed; foreign kid for chaining only; control class stated per destination; `AUDIT_ANCHOR_KEY_ROTATED` as the detection signal |
| S-2 | Major | An archived key signs forever; rotation revokes nothing | Fixed — row e (`LATEST_UNDER_RETIRED_KEY`); docs on post-rotation manifests and on what a statement proves; `--confirm` on irreversible writes |
| S-3 | Major | Several manifests on one date resolved silently by string order | Fixed — own kid preferred, `MULTIPLE_MANIFESTS_FOR_DATE` row, unrecognised keys logged (detection, declared) |
| S-4 | Major | An emptied or rolled-back destination was healed silently | Fixed — row d fails closed |
| S-5 | Major | `PUBLISHED_OBJECT_AHEAD` had no reset; the prefix reset dropped the chain | Fixed — resets per destination; chain-restart statement; credentials rotated first |
| S-6 | Minor | Nothing checked that the own public key is archived | Fixed — `ownPublicKeyArchived`, daily `OWN_PUBLIC_KEY_NOT_ARCHIVED` row, `audit-anchor-kid` reports it |
| S-7 | Minor | CLI prior-key order, lenient hex, plain http | Fixed — C2 |
| S-8 | Minor *prose* | "hash", "bind", "detects" stronger than the mechanism | Fixed — wording in C2/C6/SC1 |
| S-9 | Minor | `anchoredAt` form, kid shape, destination key shape, script hex | Fixed — C1/C2 |
| S-10 | Minor | E1 questions: 403-vs-404; break-glass read grant | 403-vs-404 removed by design (F-9). Break-glass read: the scripts' exists-compare needs `s3:GetObject`/`ListBucket` on the operator role, which this stack does not manage — stated in the runbook's prerequisites |
| S-11 | Major (adjacent) | GitHub-only verifiers cannot fetch keys by the CLI's URL shape | Fixed — documented download + `--public-key` |
| S-12 | Minor *prose* | "5 uses" did not reproduce | Fixed — count dropped |

## Testing Findings

| ID | Sev | Finding | Disposition (revision 2) |
|----|-----|---------|--------------------------|
| T-1 | Major | The two-instance test cannot exercise create-only (the lock serialises) | Fixed — split: lock case (zero `create` calls by the second) and create-conflict case with its own red proof |
| T-2 | Major | No acceptance or seam for create-exists → adopt / fail closed | Fixed — decorating destination; paired cases asserting side effects; `afterUpload` redefined |
| T-3 | Major | Fixtures share destination namespaces | Fixed — fixture contract (per-case prefix/dir, exact-set assertions, `now` default) |
| T-4 | Major | Legacy-row tests collided with the grep invariant and could be vacuous | Fixed — test-only literals in one fixture file, exact legacy formats, positive control on the pre-change code |
| T-5 | Major | The fake GitHub server cannot carry C1's acceptance | Fixed — one contract suite over four destinations; GitHub acceptance as request/response mapping; atomicity declared unverified (E2) |
| T-6 | Major | Pagination and the ordering tie untested | Fixed — injectable page size, tie cases |
| T-7 | Major | Static IAM/bucket tests not bound to requests or the new key shapes | Fixed — C5 acceptance |
| T-8 | Major | No server/CLI parity mechanism; openssl claim inaccurate | Fixed — shared vector file in both CI filters; claim removed |
| T-9 | Major | No validation of the built publisher bundle | Fixed — manual-test section |
| T-10 | Major | Upgrade path had no acceptance | Fixed — C4 upgrade case |
| T-11 | Major | Script structure and npm wiring untestable | Fixed — `from-env.ts`, `run(argv, deps)`, spawn test |
| T-12 | Major | Alarm-path coverage; fixed-return destination mock | Fixed — C4 alarm-path acceptance; stateful in-memory destination |
| T-13 | Major | Runbook test and manual record could pass while empty | Fixed — floor, flags, blob id, exit statuses |
| T-14 | Minor | 409 and size bound rest on guessed shapes | Fixed — status-code classification, unit cases; real 409 is E1 |

## Adjacent Findings

- S-11 (Security → Functionality): above.
- F-6 (Functionality → Security): merged with S-4.
- T-12 note (Testing → Functionality): a `published` outcome can recur for one boundary —
  stated in C4 (only after a rewind or a lost commit).

Perspective convergence: F-6/S-4 (silent chain restart), F-7/S-5 (resets), F-9/S-10 (403-vs-404),
F-13/S-12 (count) — each flagged by two experts.

## Quality Warnings

None (merge done by hand; no finding lacked evidence).

## Recurring Issue Check

Per-expert statuses were returned for R1–R57 and RS*/RT*; findings by rule:

### Functionality expert
R2 F-11; R3 F-12; R4 F-10; R14/R16/R50 F-9; R16 F-3; R18 F-12; R29 F-4, F-6, F-13; R38 F-1,
F-2, F-3, F-7; R40 F-11; R41 F-4, F-8; R48 F-2, F-10; R49 F-5, F-6; R55 F-6; R56 F-5.
Pass: R1, R5, R9, R10, R12, R17, R25, R32, R34, R35, R37, R42 (recomputed), R51, R52, R57.
N/A: the rest.

### Security expert
R3 S-7; R16 S-10; R29 S-4, S-12; R31 S-2; R34 S-7; R38 S-5, S-6; R41 S-11; R43 S-1, S-2; R47
S-9; R48 S-7; R49 S-1, S-2, S-3, S-8; R50 S-10; R55 S-4; R56 S-4; R57 S-3; RS3 S-9; RS5 S-1,
S-2, S-7. OK: R1, R2, R4, R5, R9, R12, R13, R14, R17, R25, R32, R35, R36, R37, R40, R42
(re-derived: destinations 3/3, verify sites 4/4), R51, RS4. N/A: the rest, RS1, RS2, RS6.

### Testing expert
R16 T-7; R19 T-12, T-4; R29 T-8; R32/R35 T-9; R41/R49 T-5; R44/R50 T-13; R48 T-8; R57 T-6; RT1
T-5, T-7, T-12, T-14; RT4 T-1; RT5 T-5; RT6 T-11; RT7 T-1, T-4, T-6; RT8 T-2; RT9 T-8; RT11
T-3. Checked, no finding: R1, R2, R3, R9, R12, R18, R33, R38, R42, RT2, RT3, RT10. N/A: the
rest.

---

# Round 2
Date: 2026-11-14

Incremental review of revision 2 by the same three reviewers. All 39 round-1 findings
confirmed resolved (F-8 and F-13 with residue, continued as F2-4 and F2-6). No Critical. New
findings, applied in revision 3 (`F2-`/`S2-`/`T2-` = round-2 numbering per expert):

| ID | Sev | Finding | Disposition (revision 3) |
|----|-----|---------|--------------------------|
| F2-1 | Major | A run crossing a boundary wrote `last_published_at` into the next one; row d then failed every run | Fixed — the written value is clamped into `[B, B + cadence)`; acceptance with red proof; upgrade note for legacy rows |
| F2-2 | Minor | Worst-case run length exceeded the 120 s stop timeout | Fixed — one 60 s bound for all destination I/O of a run |
| F2-3 | Minor | Null `H`, adopt with no matching rows, `_MIRROR_DIVERGED` stage unstated | Fixed — stated in C4 |
| F2-4 | Minor | Statement key collides within a day; chain-restart with no surviving manifest; re-archiving | Fixed — `statementArtifactKey(day, op, kid)`, `--previous-none`, restart steps |
| F2-5 | Minor | Misleading signals on rotation day / DEPLOYMENT_ID change | Fixed — row g's warn carries what differs; runbook notes |
| F2-6 | Minor *prose* | C2 member-set grep did not reproduce | Fixed — narrowed |
| S2-1 | Major | The zero-tenant skip was database-decided and healthy; dropped tenants unalarmed | Fixed — `everChainEnabled` also from the primary's listing; `TENANT_DROPPED_FROM_MANIFEST` and `CHAIN_SEQ_REGRESSION` rows; class statement reworded (one tenant's flag: detected by a row only) |
| S2-2 | Major | Row d's reset steered to a chain restart when the database is the wrong side | Fixed — split into d1 (`LAST_PUBLISHED_AHEAD_OF_CLOCK`, reset: correct the value) and d2 with a which-side diagnosis |
| S2-3 | Major | Seeding the Terraform S3 primary is impossible and unverified | Fixed — no seeding; changing the primary is a chain restart with a statement |
| S2-4 | Minor | Row g was log-only | Fixed — one `PUBLISHED_BY_OTHER_IDENTITY` row per boundary per process |
| S2-5 | Minor | Name-derived flags; class qualifier on rows d/e | Fixed — plant stated and routed to the role-credential incident; archived flag compares content; qualifier carried |
| S2-6 | Minor | GitHub `create` could delete a stored object under a race | Fixed — re-read, stale-age rule, forbidden pattern, both sides tested; remaining window declared |
| S2-7 | Minor | Chain-restart statement: live key handling, unchecked argv, key name, genesis record | Fixed — previous manifest verified from a file, runbook key handling, own key name, `genesis` in the published row |
| S2-8 | Minor | Backfill unverified, starvable, no compare | Fixed — newest first; declared a byte copy; R5 reworded |
| S2-9 | Minor *prose* | Loopback rule wording; grep output | Fixed |
| S2-10 | Minor (adjacent) | Statement publish not retryable | Fixed — signing and publishing separated (`audit-anchor-publish-statement`) |
| T2-15 | Major | Row d made publishing tests depend on anchor rows they do not own | Fixed — fixture precondition, teardown at creation, manual-test cleanup |
| T2-16 | Major | New publish-time rows invisible to fixtures; own-key row in every case | Fixed — `anchoredAt` on every row, default archiving, paired cases |
| T2-17 | Major | GitHub delete path tested on its happy side only | Fixed — DELETE-recording fake, five cases |
| T2-18 | Major | Backfill bound, order, failure path untestable | Fixed — awaited, gap-of-8 case with red proofs, throwing secondary |
| T2-19 | Minor | URL and hex vectors missed adjacent cases | Fixed — vector list |
| T2-20 | Minor | Tests on refused kids/keys not listed; vector origin | Fixed — listed in C2; generator recorded |
| T2-21 | Major (adjacent) | Two statements on one day share a key | Fixed — with F2-4 |
| T2-22 | Minor *prose* | Vector path and filter entry unnamed | Fixed — named, pinned by a test |
| T2-23 | Minor | Per-step bounds left the bound tests without a contract | Fixed — one bound, tokens per interrupted operation, hanging-`list` case |

Note on S2-6's adjacent remark (a clone deleting another instance's in-flight GitHub
upload): covered by the stale-age rule — a reservation younger than 10 minutes is never
deleted.

## Recurring Issue Check (round-2 delta)
Functionality: R38/R57 F2-1; R53 F2-2; R55 F2-4; R29 F2-6; now Pass R2, R3, R4, R16, R18, R40,
R41, R48, R49, R50, R56. Security: R42/R49/R55 S2-1; R38 S2-2, S2-3; R41/R43 S2-3; R49 S2-4,
S2-5, S2-8; R51 S2-5, S2-6; R43/RS3 S2-7; R47/R29 S2-9; now OK R31, R48, R56, R57, RS5.
Testing: RT11 T2-15, T2-16; R19 T2-16, T2-20; RT8/RT10 T2-17; RT7 T2-18; R47/RT10 T2-19; R33
T2-22; RT10 T2-21, T2-23; resolved with round 1: R16, R29, R32, R41, R44, R48, R49, R50, R57,
RT1, RT4, RT5, RT6, RT9.

---

# Round 3
Date: 2026-11-14

Incremental review of revision 3. All 25 round-2 findings confirmed resolved. No Critical,
no Major. Each expert labelled its own findings (`design`/`prose`; Minor kind (a) prose-only,
(b) only reachable by building and executing):

| ID | Sev | Label (expert's) | Finding | Disposition |
|----|-----|------------------|---------|-------------|
| S3-1 | Minor | prose (a) | d2's diagnosis cited database rows as evidence | Fixed in the plan — the destination's own evidence decides |
| S3-2 | Minor | prose (a) | Three unstated statements (zero-tenant plant, tag-secret cutover row, zero-tenant on list error) | Fixed in the plan |
| F3-1 | Minor | design (b) | Zero-tenant path: outcome on a read throw; `everChainEnabled` in `claimAttempt` | Fixed in the plan — listing only, one expression |
| F3-2 | Minor | design (b) | Chain restart with a retained secondary fails its first day | Fixed in the plan — runbook statement |
| F3-3 | Minor | prose (a) | GitHub break-point figure predates the single bound | Fixed in the plan |
| F3-4 | Minor | prose (a) | Runbook sections / `publish-statement` flag | Fixed in the plan |
| T3-1 | Minor | design (b) | Per-process state should be per publisher instance | Carried forward (Phase 2) |
| T3-2 | Minor | design (b) | Two guards without a reddening case | Carried forward (Phase 2) |
| T3-3 | Minor | prose (a) | Row g's row not stated to carry `anchoredAt` | Fixed in the plan |
| T3-4 | Minor | design (b) | Zero-tenant cells | Carried forward (Phase 2) |
| T3-5 | Minor | design (b) | Implicit boundary cells | Carried forward (Phase 2) |
| T3-6 | Minor | design (b) | Literal seed in the vector file vs secret scanning | Carried forward (Phase 2) |

## Saturation call (round 3)

1. Three rounds completed. 2. No Critical or Major open in any category. 3. No finding is
against a contract, control class or invariant: every `design`-labelled finding is kind (b)
by its expert's own classification, and each expert stated the plan phase saturated from
its side. 4. Every remaining Minor is (a) or (b). The five (b) findings not already written
into the plan are in its `## Carried-Forward Plan Findings`. All contracts `locked`.

## Recurring Issue Check (round-3 delta)
Functionality: R48 F3-1; R29 F3-3; now Pass R38, R53, R55, R57. Security: R49 S3-1, S3-2
(prose); now OK R38, R41, R42, R43, R47, R51, R55, RS3. Testing: RT7 T3-2; RT10 T3-5; RT11
T3-1, T3-3; resolved R19, R33, R47, RT8.
