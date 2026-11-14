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
