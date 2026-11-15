# Coding Deviation Log: audit-anchor-hardening

## Batch A (C1, C2)

- **D1 — S3 `read` costs a one-key LIST plus the GET.** C1 says absence is decided from a
  listing, never a GET status; `read` therefore lists the exact key (`Prefix` = the full key,
  `MaxKeys: 1`) before the GET. The plan's "one LIST and one GET per step" undercounts by one
  LIST per read. The key starts with `<prefix>/`, so it satisfies C5's `s3:prefix` condition;
  C5's test covers this form too.
- **D2 — a GitHub 422 is classified by lookup, not by its body.** A 422 counts as a taken name
  only when an asset of that name exists in the release; otherwise it throws. The body shape
  is unverified (E2).
- **D3 — `create` enforces `AUDIT_ANCHOR_ARTIFACT_MAX_BYTES` too**, so nothing is stored that
  `read` would refuse.
- **D4 — `readJwsKid` throws `InvalidSignatureError` for a JWS with no readable header**
  (`InvalidKidError` for a missing or malformed kid), as `verify` and the CLI do.
- **D5 — additions to C2's signatures:** `verifyStatement`, `InvalidPublicKeyError`, an explicit
  32-byte check on seeds and public keys; CLI `InsecureUrlError`, `InvalidPublicKeyError`,
  `PriorPublicKeyRequiredError` (exit 1).
- **D6 — the URL vectors are CLI-only** (the server has no URL rule). The upper-case-scheme
  deny matches the scheme on the raw text, because `new URL` lower-cases it.
- **D7 — filesystem `list` skips `.tmp-*` names** (a crashed create's leftover); the temp file
  is fsynced before `link()`.
- **D8 — `in-memory-destination.ts` lives under `src/lib/audit/anchor-destinations/`** (test
  support imported by unit and integration suites); the shared contract suite and the fake
  GitHub server are under `src/__tests__/helpers/`.
- **D9 — the hanging-`list`/`create` token cases moved to C4**: the `<name>_READ_FAILED` /
  `_UPLOAD_FAILED` tokens are formed by the publisher.
- **D10 — T3-6 (gitleaks on the vector file):** the fixture path is under the repository's
  `(^|/)__tests__/` gitleaks allowlist, so a scan skips it; the seed is the low-entropy
  `0x42 × 32` constant regardless.
- **D11 — one guard without its own reddening test:** the inner "refusing to delete an
  uploaded asset" check in `deleteAssetReservation` is unreachable while the outer re-read
  guard exists (defence in depth; the outer guard is red-proven).

## Batch C (C5, C7)

- **D12 — script exit codes:** 0 ok, 1 refused or failed, 2 usage error; a missing `--confirm`
  is a usage error (2). The argument-parse error is fixed text, because Node's `parseArgs`
  message would echo a positional seed.
- **D13 — a write reads every destination first:** a different object anywhere → exit 1 with
  nothing written anywhere; a `create` that answers `"exists"` is re-read and compared
  (covers a race).
- **D14 — `audit-anchor-kid` works with no destination configured** (the archived-or-not line
  is printed only when one is).
- **D15 — file formats:** `--out` is create-only; the published statement is the trimmed JWS;
  the archived `.pub` is the 64 hex chars plus a newline.
- **D16 — `chain-restart` takes the previous manifest's key** from the own key when the kids
  match, else `--previous-public-key <path>`.
- **D17 — the IAM condition test also covers D1's full-key prefix form** and a narrowed
  condition (`<prefix>/`) as a third red case.

## Batch B (C3, C4)

- **D18 — C4's acceptance "create conflict: ours-shaped under a foreign archived kid → row g"
  cannot occur.** The conflicting object sits at the own-kid key name, so a manifest signed by
  another key fails the kid binding: it is tested as fail-closed
  (`PUBLISHED_OBJECT_UNVERIFIABLE`). Row g after `"exists"` is reached, and tested, with an
  own-key object carrying another `deploymentId`.
- **D19 — "rows f–h never count" holds in step 2 only.** A run that passes step 2 and then
  skips in step 4 (another instance published in between) was already counted in step 3.
- **D20 — `publishedStateFromListing(dest, own, listedKeys, signal)`** added beside
  `readPublishedState`: the publisher lists once per step and the zero-tenant path uses the
  listing alone.
- **D21 — key cache location (T3-1):** `own` is `{ publicKey, keyCache? }`; the publisher
  instance holds the cache, and without `keyCache` nothing is cached.
- **D22 — a secondary's read failure during the mirror compare** is
  `<name>_READ_FAILED:<code>` at stage `upload`, with the pause (C4 named only
  `_UPLOAD_FAILED` for a secondary error; C1 reports a read under its own operation).
- **D23 — a listed key whose read returns null** is unverifiable (row b), not row a.
- **D24 — `MULTIPLE_MANIFESTS_FOR_DATE`** is counted from the listing for the date of the
  manifest's `previousManifest.uri` key, so it also works on an adopted publish.
- **D25 — `MISSING_PRIOR_CADENCE_PUBLICATION`** keeps today's query, runs on adopt too, and
  carries `anchoredAt`.
- **D26 — `last_published_at` and the pause-clear** go to the anchor rows whose tag is in the
  stored manifest on fresh publishes as well as adopts (one code path).
- **D27 — no destination configured** fails the run with `CADENCE_FAILED:NO_DESTINATION`.
- **D28 — the non-writable filesystem primary test** uses a `0555` parent with a non-existent
  base path (empty listing, `create` fails with EACCES); the old `/dev/null/…` path now fails
  at `list`. Assumes a non-root test runner.
- **D29 — the integration "anchor rows deleted → not healthy" case** first asserts that no
  anchor row at all remains in the database, with a message naming the cleanup.
- **D30 — logging:** `PublishedObjectUnverifiableError` carries a `detail` token, logged only
  in the new `published_object_unverifiable` line; `_MIRROR_DIVERGED` and row a emit no
  `upload_failed` line, so they match only the `cadence_failed` filter; `stale_boundary`
  carries `latestArtifactKey` in place of `marker`. New `_logType`s: `published_object_unverifiable`,
  `published_by_other_identity`, `previous_manifest_deployment_changed`,
  `mirror_backfill_failed`, `unrecognised_manifest_key`. None renamed.
- **D31 — `AnchorDestinationConfigError` has a `code`** (`NO_DESTINATION_CONFIGURED`,
  `GITHUB_TOKEN_MISSING`) and the runner logs a fixed message with `errorLogFields(err)`
  (the `check-caught-error-logging` gate refuses `msg: err.message`).
- **D32 — the rotation acceptance archives the old key with `destination.create`**, not through
  C7's `run` (the two batches were written in parallel); C7's own tests cover `run`.
- **D33 — legacy-row positive control** (scratch copy of the pre-change tree at `dcc1eded9`,
  not in the repository): a marker at `B` with no object made the old publisher return
  `skipped_already_published`; a pointer naming an older manifest redirected
  `previousManifest` to it. 2 passed, exit 0.
- **D34 — two red-proof mutations were equivalent and stayed green:** `??=` → `=` on the
  bound's timer (the old timer still fires; the real per-call mutation is red), and
  swallowing the listing error in the hanging-`list` case (the next read yields the same
  token; row a's own case is red).

## Batch D (C6, C8) and what writing the docs found

- **D35 — S3 service errors are named by the SDK exception's `name`.** An AWS SDK service
  exception has no `code`, so `errorLogFields` reduced every S3 refusal to `unknown`
  (`s3-object-lock_READ_FAILED:unknown` for a missing read grant, where C5 promised
  `AccessDenied`; the same held for today's `_UPLOAD_FAILED`). The publisher's destination
  tokens now fall back to the exception's token-shaped `name` when the error carries
  `$metadata`. Found by a read-only LIST with bad credentials against MinIO; tested with the
  SDK's own `S3ServiceException`.
- **D36 — a future-dated garbage manifest key is row b, not row c.** The latest manifest is
  verified before its date is compared, so `PUBLISHED_OBJECT_AHEAD` needs a manifest that
  verifies. C3's "garbage or future-dated key (rows b, c)" is row b for garbage. Docs follow
  the code.
- **D37 — rolling back to a pre-protocol release is unsafe** once this one has published: the
  old publisher trusts the marker row this release no longer updates, would re-PUT the day's
  key and chain to the stale pointer. Documented in `deployment.md` and the runbook (read from
  `dcc1eded9`, not executed).
- **D38 — tag-secret cutover edge:** an adopt of a manifest built under the old secret matches
  no anchor row under the new one and never settles; the runbook says to switch after the
  day's `published` line.
- **D39 — `worker-policy-manifest.json` `modules`** gains only `anchor-published-state.ts`: the
  sweep-bounds scanner reads the `DELETE` string in `github-release-destination.ts` as an
  unjudgeable write, so the destination files stay out, with a `$modules-note` saying why.
- **D40 — `scripts/deploy.sh` already applies Terraform before it moves the services**; the
  upgrade order is stated as a requirement it satisfies.
- **D41 — doc corrections beyond the plan:** `audit-verify --my-tenant-id` returns before the
  `--prior-manifest` check (pre-existing; the example now shows two runs); exit 18 added to
  the table; the runbook's reference to a `block-secret-key-destruction.sh` hook that exists
  nowhere is dropped; `docs/setup/aws/en.md` no longer says the task role is write-only.
- **D42 — `SUBCOMMANDS` in `scripts/audit-anchor-keys.ts` is exported** for the runbook test.
- **D43 — simplify pass:** the single-use `wallClockBoundaryMs` helper and the unused
  `manifestKeysOf` export were removed; the other proposals touched locked tokens or
  operator-visible text and were left.

## Step 2-4 gates

- `npx vitest run`: 22725 passed, 6 failed — all `scripts/__tests__/backup-db.test.mjs` Group B
  ("a real archive reader is required"), which fails when run from a git worktree and does
  not touch this change.
- `npx next build`: pass. Anchor integration set (7 files, real Postgres + MinIO): 95 passed, 1 todo.
- `scripts/pre-pr.sh`: 97 steps pass; two fail, neither from this branch —
  `Test` (the `backup-db` cases above) and `Static: rls-cross-tenant SQL parse`
  (`E-RLS-BYPASS-ROUTINE share_creator_admitted`): that step runs the branch's verify SQL
  against the shared dev database `passwd_sso`, whose schema is the main checkout's branch,
  not this worktree's database. This branch changes no migration and no RLS file
  (`git diff --stat main...HEAD -- prisma scripts/rls-*` is empty). CI runs both on a clean
  checkout and a fresh database.
- Forbidden patterns (C1, C2, C4): no hit in non-test source; one `method: "DELETE"`, in the
  reservation-removal function of `github-release-destination.ts`.

## Step 2-5 self-R-check

Three focused passes (functionality, security, testing) over the recurring-rule checklist:
no Critical, no Major; ten Minor, all fixed in this phase.

- **R49 (security)** — the key scripts echoed the value of `--key-file` / `--old-key-file` /
  `--out` in open- and write-failure messages, so a seed pasted as the flag's value reached
  stderr. The messages now name the flag and the errno only.
- **R48 (security)** — the GitHub destination listed an uploaded asset under any
  `audit-anchor-*` tag, while `read`/`create` look a key up only under its own tag. `list`
  now reports a key only where its own location is that tag and name.
- **R49 / RS6 (security)** — `InvalidAlgorithmError` / `InvalidTypError` interpolated the raw
  `alg` / `typ` of an unverified header (server and CLI), and the scripts printed
  `err.message`. Both classes now `JSON.stringify` the value; the scripts print a
  token-shaped name and code.
- **R48 (security)** — the CLI threw a `TypeError` for a header that decodes to JSON `null`;
  it now throws `InvalidSignatureError` like the server (vector added, asserted on both sides).
- **R29 / R4** — `COMMIT_FAILED_AFTER_UPLOAD` and `ARTIFACT_TOO_LARGE` gained rows in the
  alerts and runbook tables; the mirror backfill is stated as log-only (a differing older
  mirror object reaches no alarm).
- **R2** — the artifact content types are one exported constant in `anchor-artifact-keys.ts`.
- **R29** — the `ownKey` getter comment now says the entrypoint derives the key at boot.
- **RT11** — the CLI tests remove their temp dirs. **RT4** — the S3 two-instance case
  observes the second instance waiting in `pg_locks`. **RT3** — tests import the time and
  anchor constants instead of re-declaring them.

The pass that applied these was interrupted by a session restart before it reported; the
orchestrator re-verified the result (type-check, unit 1444 passed, CLI 484 passed, anchor
integration 95 passed, eslint and the two static checks green). The per-fix red proofs were
not re-run after the interruption; each fix has a test that names its guard.

## Phase 3, round 1 fixes

- **D44 — `anchor-publisher-key-load.integration.test.ts` is in the Implementation Checklist
  and not in the diff:** it tests the application key provider only and references nothing
  this change removed; no edit was needed.
- **D45 — the run's tenant set is the chain-enabled tenants that have an anchor row**
  (rows are created lazily by the outbox worker). With none, the run takes the no-tenant
  path, so `skipped_no_tenants` can now carry `chainEnabledTenantCount > 0`. The
  `chain-enabled-fell-to-zero` metric filter requires `= 0`, so that state shows through the
  cadence-absent alarm when `everChainEnabled` is true and is the healthy skip when false.
  No Terraform change; the docs say so.
- **D46 — rows on an adopted publish:** plan C4 said the drop/regression rows are not emitted
  on an adopted publish. They now are (code review S-1), with `EPOCH_CHANGED` (S-2) and
  `PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON`, and a `previous_manifest_unavailable` warn
  line naming which of missing / unverifiable / hash mismatch / destination error occurred.
- **D47 — `publish-pubkey` compares the parsed key**, not bytes, and sends no `create` to a
  destination its pre-check found holding the key (`exists (same key)`).
- **D48 — the CLI's bounded read** stops at the first network chunk past the bound, not at
  exactly bound + 1 bytes.
- **D49 — one mutant stayed green:** the filesystem read loop's `total <= MAX` condition is
  equivalent under the chunk sizing; the cap and the post-read check are each red-proven.
- **D50 — S-7 accepted** (a manifest is not bound to its location); see the code-review
  file's Resolution Status for the Anti-Deferral entry.

## Phase 3, round 2 fixes

- **D51 — unsettled manifests are compared by a walk, not one extra step (S2-1).** After any
  `published` outcome (fresh or adopted) the publisher walks back from the compared-to
  manifest through every manifest dated after the published high-water read under the lock
  (all of them when there is no high-water), comparing each with the predecessor it names.
  The one-step fix the finding proposed misses a lock held into the next day's first attempt
  (the retry adopts) and a lock held for two days. A failed or timed-out read ends the walk
  with the UNAVAILABLE row. (Round 3 added a cap: see D55.)
- **D52 — residual, stated in the threat model:** a database writer who moves
  `last_published_at` onto an unsettled manifest's date makes it count as settled and the walk
  skips it; the failed run's `commit_failed_after_upload` alarm and row remain. Closing it
  needs a settle marker outside the database.
- **D53 — a null high-water over an existing chain is walked on every publish while it stays
  null** and re-reports historical drops — bounded, since round 3, by the walk's cap (D55).
- **D54 — `comparedArtifactKey` is on all four comparison rows** (for a row about the new
  manifest it equals `artifactKey`); `previousOfAdopted` is renamed `namedPrevious`.

## Phase 3, round 3 fixes

- **D55 — the walk is capped** at `AUDIT_ANCHOR_UNSETTLED_WALK_MAX` (7) manifests compared;
  when the cap cuts it, one `UNSETTLED_WALK_TRUNCATED` row carries the count and the last
  manifest compared. A chain of exactly the cap that reaches a settled manifest or genesis
  produces no truncation row.
- **D56 — order after the commit:** the outcome's own rows are flushed, then the mirror
  backfill runs, then the walk, then the walk's rows are flushed. The flush is split so a
  hung mirror cannot delay the outcome's rows by the bound; walk rows therefore follow
  `AUDIT_ANCHOR_PUBLISHED`.
- **D57 — the D52 residual is cheaper than first stated** (one failed commit after the create,
  then a write to `last_published_at`); the creator-side comparison that would close it is a
  follow-up, not part of this change.

## Final gates (after code review round 4)

- `scripts/pre-pr.sh` on the committed tree: 97 steps pass; the same two environment-bound
  steps fail as in Step 2-4 — `Test` (only `scripts/__tests__/backup-db.test.mjs` Group B,
  6 cases, a git-worktree limitation; 22802 other tests pass, CLI 508 pass) and
  `Static: rls-cross-tenant SQL parse` (runs against the shared dev database `passwd_sso`,
  whose schema belongs to another branch; this branch changes no migration or RLS file).
- `npx next build`: pass. Anchor integration set: 99 passed.
- After merging `origin/main` (which brought the migrations the dev database already had):
  `scripts/pre-pr.sh` — 98 steps pass, including `Static: rls-cross-tenant SQL parse`; only
  `Test` fails, on the same six `backup-db.test.mjs` Group B cases (23134 other tests pass).
  That file and `scripts/backup-db.sh` are byte-identical to the primary checkout's, where
  the file passes 239/239 (`npx vitest run scripts/__tests__/backup-db.test.mjs`): from a
  worktree, docker compose derives another project name and finds no `db` service to run
  `pg_restore` in. Anchor integration set on the merged tree: 99 passed.

## Addendum contracts C9–C12 (the former follow-ups, done in this change)

Supersedes D50 (S-7 accepted), D52 and D57 (the residual and its follow-up), SC1 and SC3.
The plan's C1–C8 text predates these: where it says manifest `version: 1`, exit codes up to
19, "ours" without a location, rows only after a publish, or `lock_held` on any 55P03 before
the commit path, the addendum and the entries below are what the code does.

- **D58 — the chain gate runs ahead of rows c, d1 and d2** (C10): a v1 latest whose date
  differs from the high-water's reports `LEGACY_MANIFEST_UNSETTLED` rather than
  `DESTINATION_BEHIND_DATABASE` / `PUBLISHED_OBJECT_AHEAD`; the runbook routes it to
  "Telling which side is wrong".
- **D59 — `isOurs` carries no location clause:** every caller runs the gate
  (`assertOfThisChain`) first, so "ours" is kid + deployment over manifests the gate admitted.
- **D60 — a v1 manifest is never adopted:** acceptance needs it settled, adoption needs it
  not. The upgrade acceptance "a run for the same boundary adopts without a third version"
  is replaced: a recorded v1 skips, an unrecorded one fails closed, the next boundary chains
  in v2.
- **D61 — `lock_held` only before the primary holds the object:** a 55P03 raised after the
  create used to return `lock_held` with a stored manifest and no rows; it is now a failed run
  with the comparison rows. In practice that is `COMMIT_FAILED_AFTER_UPLOAD:55P03` at stage
  `after_upload`: a row lock on `audit_chain_anchors` (which anyone with UPDATE can hold)
  times out the anchor-row update. The code also handles a lock timeout between the create
  and that update as `CADENCE_FAILED:55P03` at stage `upload`, but the publish transaction
  already holds a read lock on the table from its earlier reads, so a table-level lock cannot
  make its later read wait (probed on the worktree database: with a prior read in the same
  transaction the later read returned at once while the other session's `LOCK TABLE … ACCESS
  EXCLUSIVE` timed out; a table lock taken before the transaction's first read fails the run
  before anything is stored). An earlier version of this entry and of `alerts.md` stated the
  table-lock arm as reachable; the functionality reviewer was right that it is not.
- **D62 — order on a failed run** (C11): pause, the failure row, then the comparison rows, so
  a hung read-back cannot delay the alarm line. A drop reported by the failed run is reported
  again by the adopt that settles it.
- **D63 — C10 residual narrower than the addendum states:** a destination writer alone can
  get a copied v1 accepted when its date equals the high-water's date, no own-kid key holds
  that date (a rotation day) and the copied key sorts after the legitimate one; the publish
  then writes `MULTIPLE_MANIFESTS_FOR_DATE` and `AUDIT_ANCHOR_KEY_ROTATED`. Stated in the
  threat model.
- **D64 — C12 upgrade window:** with the pointer row deleted, the PREVIOUS release's
  publisher, if it publishes between the migration and its replacement, signs a manifest
  naming no predecessor. On the Terraform bucket C9 refuses its unconditional PUT; elsewhere
  `deployment.md` says not to let an upgrade span 00:05 UTC.
- **D65 — CLI:** the location check runs before the hash-link check and also on a genesis
  current manifest, so "restart at a new location, v2 prior" is exit 20, not PASS with a WARN.
- **D66 — locations:** GitHub's names the repository only; a filesystem path renamed or
  reached through another mount is another location; a former secondary promoted to primary
  is refused (`PUBLISHED_OBJECT_FOREIGN_LOCATION`) — its manifests carry the old primary's
  location. All documented.
- **D67 — what stays uncompared after C11:** a manifest whose creator was killed before
  writing its rows AND whose date the high-water then reached (a database write, or the
  settling run killed between its commit and its rows). Stated in the threat model.
- **D68 — C12 route:** a self-granting `DO` block (the precedent of `20261109162613`), no gate
  baseline entry; tested as `passwd_app` in a rolled-back transaction. While writing it a
  comment in the already-applied migration was edited; the worktree database's history row
  was deleted and the migration re-applied, so the recorded checksum matches the file.
- **D69 — C9 verification:** static tests only; `terraform validate` runs in CI, not here; the
  live effect is E1 (manual-test record).

## Phase 3, round 5 fixes (on C9–C12)

- **D70 — C9 uses `BoolIfExists`**, so an absent `s3:ObjectCreationOperation` cannot leave the
  Deny binding nothing. The docs state both ways the statement can be wrong (every create
  refused; or no refusal and no alarm) and say the policy is statically pinned, not yet
  exercised on AWS; a one-time scratch-bucket procedure is in `infra/terraform/README.md`
  (its `aws` commands were not run here). Supersedes D69's wording.
- **D71 — a v1 latest is refused when another manifest key shares its date** (closes D63 on
  stores where the legitimate key cannot be deleted). Cost: two v1 keys on the high-water's
  date wedge the publisher, and on the Terraform bucket the reset is a chain restart; the
  earlier release never wrote two manifests for one boundary, so this is not an upgrade path.
- **D72 — `GENESIS_AFTER_EARLIER_MANIFESTS`**: a manifest naming no predecessor while an
  earlier manifest key exists is reported with the publish that chains to or adopts it (and
  by a failing run that stored the object). On an adopt the predecessor the adopted manifest
  names is checked too. This is what D64's upgrade window now leaves on record.
- **D73 — location spelling:** a relative `AUDIT_ANCHOR_DESTINATION_FS_PATH` is refused where
  destinations are built from the environment (`FS_PATH_NOT_ABSOLUTE`; the publisher and the
  key scripts share that code, the env schema is not involved); the GitHub location is
  lower-cased while API calls keep the configured spelling. Supersedes part of D66.
- **D74 — the manual test was repeated on the final code** (manual-test record, section 5):
  the built bundle writes format version 2 with the expected `chainLocation`; the
  `LEGACY_MANIFEST_UNSETTLED` state and its runbook SQL were exercised end to end.

## Phase 3, round 6 (confirmation) — inline minors applied

- **D75 — tests and wording only:** a test for the adopt's predecessor check in
  `genesisEmits` (red-proven); a test pinning the README's hand-copied policy JSON (en and ja)
  to the `DenyUnconditionalPut` statement; the scratch-bucket procedure's cleanup line; the
  threat model lists the second-key wedge during the first day after an upgrade; `alerts.md`
  states the lock-timeout behaviour as in D61.

## Final gates (after code review round 6, `origin/main` merged again)

- `scripts/pre-pr.sh`: 99 steps pass; `Test` fails only on the six `backup-db.test.mjs`
  Group B cases (23390 other tests pass; CLI 527 pass). The test file and
  `scripts/backup-db.sh` are byte-identical to the primary checkout's, where the file passes
  239/239 — the failure is the git-worktree limitation recorded above, not this change.
- Anchor integration set (8 files, real Postgres + MinIO): 113 passed. `npx next build`: pass
  (inside the pre-PR run).
- The first integration run after the merge failed to load one file
  (`SyntaxError` in the generated Prisma client): the pre-PR run was regenerating the client
  at that moment. Re-run once it had finished: 113 passed.
