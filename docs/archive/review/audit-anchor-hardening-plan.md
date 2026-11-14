# Plan: audit-anchor-hardening

Issues: #949 (harden the audit-anchor publication protocol), #950 (key-rotation runbook
scripts). One PR, branch `feat/audit-anchor-hardening`. Revision 3 (round-1 and round-2
findings applied; their history is in `audit-anchor-hardening-review.md`).

## Project context

- Type: web app + workers (`mixed`). The subject is the `audit-anchor-publisher` worker, its
  destinations, the `passwd-sso audit-verify` CLI and operator scripts.
- Test infrastructure: unit + integration (real Postgres, MinIO as S3) + CI/CD.
- Verification environment constraints:
  - **E1** — real AWS (S3 bucket policy, IAM, ECS). `terraform plan/apply` and the `aws` CLI
    are not run without the user's say. S3 behaviour is exercised on MinIO with root
    credentials, so no policy is exercised there; Terraform is checked statically
    (`src/__tests__/infra/*`, `terraform validate/test` in CI). Unobservable locally: the IAM
    read grant, `409 ConditionalRequestConflict`, 403-vs-404 on a missing key.
  - **E2** — real GitHub Releases API (no token). Exercised against a `node:http` fake shaped
    from the documented API; asset-upload atomicity and the 422 body are unverified.
  - **E3** — a second publisher host / ECS deploy.

## Objective

Make the published objects, not `system_settings`, decide what the publisher does; make a
retry unable to leave a second version of a manifest key; accept a signature only under the
key its `kid` names; and make the rotation runbook executable as written.

## Background (what is true today)

- `runCadence` decides "already published" from `system_settings.audit_anchor_last_published_boundary`
  (falling back to `MAX(last_published_at)`) and takes `previousManifest` from
  `system_settings.audit_anchor_previous_manifest`. Neither is checked against the
  destination: a `system_settings` writer can suppress publication or redirect the chain.
- `S3Destination.upload` is an unconditional PUT. The publisher role has no GET or LIST.
- `verify` (server) and `verifyJws` (CLI) ignore the header `kid`.
- The runbook names four npm scripts that do not exist and an overlap window no code implements.

## Requirements

- R1. A boundary counts as published only when a verified manifest object for its date exists
  at the primary destination. No database value alone produces a skip that reads as healthy,
  or chooses `previousManifest`.
- R2. Manifest writes are create-only at every destination. A write that finds the key taken
  reads the object back: one the publisher's own key signed is adopted, anything else is not.
- R3. A signature is accepted only under the key its header `kid` names. A `kid` other than
  the publisher's own is resolved from the archive path `public-keys/<kid>.pub`, and is
  trusted for chaining across a rotation only — never for adoption.
- R4. Every fail-closed state has a documented reset (C4 table) and reaches the existing
  `cadence_failed` alarm path.
- R5. Secondary destinations mirror the primary's bytes: the boundary's own object within the
  run (a diverging one fails the run), older gaps by a bounded byte-copy backfill on later
  publishing runs.
- R6. A GitHub- or filesystem-primary deployment runs the same protocol; where the store does
  not separate the key archive's writer from the manifests' writer, the plan and docs say what
  the checks do not bound (C3).
- R7. The verifier enforces `kid` binding and documents the one-version-per-key rule.
- R8. The runbook's scripts exist or are replaced by something that does; no "not yet
  automated" marker remains; every runbook command is run once and recorded, or recorded as
  not runnable here (SC6).

Non-functional: no new environment variable (the ECS task enumerates its env in `ecs.tf`);
the only Terraform resource change is the publisher's IAM policy in `iam.tf` (comment-only
edits elsewhere are listed in C8); all destination I/O of one run shares one 60 s bound, so
a run's worst case stays what it is today (60 s + two 10 s lock waits, under the task's 120 s
stop timeout).

## Technical approach

The primary destination (first configured: S3, else GitHub, else filesystem — the existing
order) is the source of truth. One listing of it yields everything a run decides on: the
latest manifest, whether its date holds more than one, whether the publisher's own key has
published before, whether the own public key is archived. The database keeps what only it
knows — the anchors, the attempt count, the advisory lock — and `last_published_at`, which
can make a run *do more* (adopt again) or *refuse* (destination behind), never skip.

### Concurrency probe (create-only write)

`If-None-Match: *` on an Object Lock, versioned bucket, probed against the local MinIO (the
image digest CI uses):

```
sequential first : created
sequential second: PreconditionFailed/412     versions: 1   stored body: one
concurrent x8    : ["created","PreconditionFailed/412" ×7]  versions: 1
env-endpoint list: ok 2     # AWS_ENDPOINT_URL_S3 alone reaches MinIO
```

The probe becomes C1's integration test. The advisory lock is unchanged from #940.

## Contracts

### C1 — Destination interface

`src/lib/audit/anchor-destinations/destination.ts`; `upload` is removed.

```ts
export interface AnchorDestination {
  readonly name: string;
  /** Create-only. "exists": the key is already held by a stored object; nothing was written. */
  create(args: { artifactBytes: Buffer; artifactKey: string; contentType: string; signal?: AbortSignal }): Promise<"created" | "exists">;
  /** The stored bytes, or null when there is none. Throws past AUDIT_ANCHOR_ARTIFACT_MAX_BYTES. */
  read(artifactKey: string, signal?: AbortSignal): Promise<Buffer | null>;
  /** Every stored artifact key, of any shape, in no particular order. */
  list(signal?: AbortSignal): Promise<string[]>;
}
```

- `create` and `read` refuse (throw) a key that is not one of C2's shapes.
- `AUDIT_ANCHOR_ARTIFACT_MAX_BYTES = 8 MiB` in `src/lib/constants/audit/audit.ts`.
- S3: `IfNoneMatch: "*"`; classification by `$metadata.httpStatusCode` — 412 → `"exists"`,
  409 retried at most twice then thrown. `list`: `ListObjectsV2` under the prefix, paginated,
  page size a constructor option (default: the API's). Key absence is decided from `list`,
  never from a GET's status (E1: 403-vs-404). The list-prefix string comes from one exported
  function that the IAM condition test uses.
- Filesystem: temp file in the target directory, `link()` to the final name (`EEXIST` →
  `"exists"`), temp unlinked in `finally`. `list` walks the base path and `public-keys/`.
- GitHub: key ↔ (release tag, asset name) is one pair of functions — manifest →
  (`audit-anchor-<date>`, key); `public-keys/<kid>.pub` → (`audit-anchor-public-keys`,
  `<kid>.pub`); `key-rotation-…` → (`audit-anchor-key-rotation`, key). Only an asset in state
  `uploaded` is a stored object. `create`: a 422 for a taken name → look the asset up;
  `uploaded` → `"exists"`; any other state is a name reservation without content: if it is
  older than `GITHUB_ASSET_RESERVATION_STALE_MS` (10 min, above any upload bound) its state
  is read once more and, still not `uploaded`, that asset id is deleted and the upload tried
  once more (a second 422 throws); a younger one throws (another writer may be mid-upload).
  Any other 422 throws. The window between the re-read and the delete is declared with the
  tripwire class below. `list`: page releases
  (`per_page=100`, page size injectable), keep anchor-prefixed tags.
  Cost: one request per 100 releases — 26 requests per listing at 7 years of daily releases
  (2555/100), two listings on a publishing run, all inside the run's one 60 s bound; when
  the listings outgrow it the bound fires as `UPLOAD_TIMEOUT` (alarmed). Unrelated releases in the repository count too;
  the deployment doc says to use a dedicated repository.
- Invariant (app-enforced): no destination offers an unconditional write. Member set —
  `git grep -nE "implements AnchorDestination"` → `FilesystemDestination`,
  `GitHubReleaseDestination`, `S3Destination`. The type forces the test fakes.
  Not platform-enforced on S3: SC1.
- Control class: `fail-closed verification gate`. Authority: the store's own conditional
  result (S3 412, `link()` EEXIST). For GitHub the authority is the API's name-uniqueness,
  unverified (E2) — declared `best-effort tripwire` there.
- Forbidden patterns (non-test source)
  - `pattern: \.upload\( — reason: unconditional write path`
  - `pattern: writeFile\([^)]*artifactKey — reason: non-atomic, overwriting`
  - `pattern: method: "DELETE" outside the one reservation-removal function of github-release-destination.ts — reason: no other delete of a stored artifact`
- A timeout surfaces under the operation it interrupted: `<name>_READ_FAILED:UPLOAD_TIMEOUT`
  for `list`/`read`, `<name>_UPLOAD_FAILED:UPLOAD_TIMEOUT` for `create`. A filesystem `list`
  of a base path that does not exist yet is empty, not an error.
- Acceptance
  - One contract suite run against S3 (MinIO), filesystem, the fake GitHub server and the
    in-memory destination the unit tests use: second `create` → `"exists"` with the first
    writer's bytes; absent `read` → null; `list` is exactly the created set, manifest and
    non-manifest; a key of no known shape is refused, a known one accepted.
  - S3 and filesystem only: eight concurrent creates → one `"created"`; S3 one version.
  - S3 pagination with page size 2 over 5 keys → the exact set (red: the continuation loop
    removed). GitHub the same with its page size.
  - S3 unit: 409 then success; 409 ×3 throws; 409 then 412 → `"exists"`.
  - GitHub mapping (the fake models asset state and records every DELETE): taken + `uploaded`
    → `"exists"`, zero DELETEs, bytes unchanged; taken + stale reservation → exactly one
    DELETE of that asset id, then one upload; taken + fresh reservation → throws, zero
    DELETEs; a second 422 after the re-upload → throws, no second DELETE; the DELETE failing →
    throws, no upload; a 422 of another kind throws. The existing "two uploads of different
    bytes" test is removed (create-only makes it impossible).
  - Hanging `list` and hanging `create` each end in their own token within the bound.
- Consumers: the publisher (C4) uses all three; the scripts (C7) use `create`, `read`, `list`.

### C2 — Key shapes, `kid` binding, strict inputs

`src/lib/audit/anchor-artifact-keys.ts` (new; `buildManifestArtifactKey` moves here):

```ts
buildManifestArtifactKey(boundary: Date, kid: string): string          // YYYY-MM-DD.kid-<kid>.jws
parseManifestArtifactKey(key: string): { date: string; kid: string } | null
publicKeyArtifactKey(kid: string): string                              // public-keys/<kid>.pub
statementArtifactKey(day: Date, op: "rotation" | "chain-restart", signerKid: string): string
                                                                       // key-rotation-YYYYMMDD.<op>.kid-<kid>.jws
isAnchorArtifactKey(key: string): boolean                              // one of the three shapes
```

`src/lib/audit/anchor-manifest.ts`:

```ts
kidForPublicKey(publicKey: Buffer): string       // prefix + hex(first 8 bytes)
publicKeyForSigningKey(seed: Buffer): Buffer
parsePublicKeyHex(text: string): Buffer          // exactly 64 lower-case hex chars after trim; else throws
readJwsKid(jws: string): string                  // throws InvalidKidError
sign(canonicalBytes: Buffer, signingKey: Buffer): string                    // manifest typ, kid derived
signStatement(payload: Buffer, signingKey: Buffer): string                  // AUDIT_ANCHOR_STATEMENT_TYP, kid derived
verify(jws: string, publicKey: Buffer): Manifest                            // KidMismatchError when header.kid !== kidForPublicKey(publicKey)
```

- The `kid` pattern narrows to the only derivable shape, `audit-anchor-[0-9a-f]{16}`, in both
  twins. The manifest schema requires `anchoredAt` in the exact form `toISOString()` writes.
- The `kid` is a 64-bit identifier of the key, not a commitment to it: binding stops a
  manifest being checked under the wrong key; it adds nothing against a party who serves both
  the manifest and the key. Docs use that wording.
- CLI twin (`cli/src/commands/audit-verify.ts`, `cli/src/index.ts`): `KidMismatchError` → exit
  19; keys parsed by the same 64-hex rule; for the manifest and archive URLs any scheme but
  `https:` is refused, except `http:` when the parsed `URL.hostname` is exactly `localhost`,
  `127.0.0.1` or `[::1]`. Prior-manifest key: same `kid` as the current manifest → the current
  key; else `--prior-public-key <path>`; else the archive, only when the current key also came
  from the archive; else an error naming `--prior-public-key`.
- Invariant (app-enforced): every signature check binds the `kid`. Member set —
  `git grep -nE "\b(verify|verifyJws)\(" -- src/lib/audit/anchor-manifest.ts src/workers scripts cli/src/commands`
  → the definitions of `verify` (`anchor-manifest.ts`) and `verifyJws` (`audit-verify.ts`), and
  `verifyJws`'s two callers in `auditVerifyCommand` (the manifest and the prior manifest); after
  the change also `anchor-published-state.ts` and `scripts/audit-anchor-keys.ts`, both through
  `verify`. Test callers (`anchor-manifest.unit.test.ts`, the `verifyManifest` alias in
  `audit-anchor-publisher.integration.test.ts`) go through the same two functions.
- Tests built on kids or keys the new rules refuse are rewritten: `anchor-manifest.unit.test.ts`
  (8-char kid), `anchor-publisher-fixtures.ts` (12-char kid),
  `audit-anchor-s3-destination.integration.test.ts` (uniqueness moves from the key to a
  per-case prefix), the CLI suites' hand-built kids.
- Control class: `fail-closed verification gate`. Authority: the public key bytes.
- Forbidden patterns (non-test source)
  - `pattern: signingKeyKid — reason: the kid is derived where it is used`
  - `pattern: Buffer\.from\([^)]*"hex"\) on a public key or seed read from a file/argv — reason: lenient parse; use parsePublicKeyHex / the seed twin`
- Acceptance
  - One checked-in vector file, `cli/src/__tests__/fixtures/audit-anchor-vectors.json`, read
    with `fs` by the CLI suite and the server suite; that exact path is added to the `app`
    filter of `.github/workflows/ci.yml` (the `cli` filter already covers it), and a test
    reads `ci.yml` to pin both. Contents, each with the helper that generated it recorded
    beside the file: seed → public key → kid (literal golden values); a manifest JWS; the
    same payload under a header naming another valid kid; a malformed kid; key texts — 64 hex
    with a trailing newline (allow), 63, 65, upper-case, 64 with one non-hex char (deny);
    URLs — `http://localhost`, `http://127.0.0.1`, `http://[::1]` (allow), an upper-case
    scheme, `http://127.0.0.1.example.com/`, `http://127.0.0.1@example.com/` (deny, and
    `fetch` not called). Each side asserts the same outcome per vector, including which error
    wins when both kid and signature are wrong (kid first).
  - `audit-anchor-key-contract.test.ts` uses `kidForPublicKey` (no local re-derivation).
  - Prior-key resolution: each of the four branches, the error branch paired with the
    same-kid allow.
- Consumers: `audit-verify` builds `<archive>/<kid>.pub` (unchanged). A GitHub archive answers
  with a redirect the CLI refuses: the verification doc tells GitHub-only verifiers to
  download the key (`gh release download` / `curl -L`) and pass `--public-key`.

### C3 — Published state, read from the primary

`src/lib/audit/anchor-published-state.ts` (new)

```ts
type VerifiedManifest = { artifactKey: string; date: string; kid: string; bytes: Buffer; manifest: Manifest; sha256: string };
type PublishedState = {
  latest: VerifiedManifest | null;        // null only when no manifest key is stored
  latestDateKeyCount: number;             // manifest keys on latest's date
  ownKidHasPublished: boolean;            // some manifest key NAME carries the own kid (not read)
  ownPublicKeyArchived: boolean;          // public-keys/<own kid>.pub is listed and its content is the own key
                                          // (read once per process, a match cached)
  manifestKeys: string[];                 // for C4's mirror backfill
};
readPublishedState(dest: AnchorDestination, own: { publicKey: Buffer }, signal?: AbortSignal): Promise<PublishedState>
readVerifiedManifest(dest, artifactKey, own, listedKeys: string[], signal?): Promise<VerifiedManifest>
```

- `latest`: among manifest keys on the greatest date, the own-kid key if there is one, else
  the greatest key. Only that object is read.
- "Verified" is all of: the `kid` is the own one, or `public-keys/<kid>.pub` is listed and
  parses (`parsePublicKeyHex`) to a key whose `kidForPublicKey` is that `kid`; `verify`
  passes; the key's `kid` equals the header's; the key's date equals the UTC date of
  `anchoredAt`. Otherwise `PublishedObjectUnverifiableError`
  (`code: "PUBLISHED_OBJECT_UNVERIFIABLE"`). Foreign keys are cached per process only once
  resolved; a miss is never cached.
- A key under the prefix matching the bucket policy's manifest glob but not
  `parseManifestArtifactKey` is logged (`unrecognised_manifest_key`) and ignored.
- `sha256` is over the JWS payload bytes — what `previousManifest.sha256` and the CLI's
  `ChainBreakError` already use.
- Control class and what it bounds, per adversary:
  - database writer — `enforceable boundary` on every destination: no database grant writes a
    destination, and nothing here reads the database.
  - a writer of the destination without the current signing key — on the Terraform S3 bucket
    the key archive is writable only by the break-glass role (`storage.tf`, existing), so a
    foreign `kid` resolves only to a key an operator archived: `fail-closed verification
    gate`. On GitHub, the filesystem, or an S3 bucket without that policy the same writer can
    archive a key of its own: there the foreign-`kid` check is a `best-effort tripwire` — it
    catches corruption and misfiling; a forged predecessor is *detected* by the
    `AUDIT_ANCHOR_KEY_ROTATED` row C4 emits, not prevented. Adoption never rests on it (C4).
    The same writer can also delete there, so C4's rows d and e are tripwires on those
    stores too.
  - holder of the publisher role's credentials without the signing key (Terraform S3) — can
    only wedge: a garbage or future-dated manifest key (rows b, c), or a key *named* with a
    newly archived kid (row e, since `ownKidHasPublished` reads names); a planted
    manifest-named key also turns a never-enabled deployment's healthy skip unhealthy. All alarmed; all
    repeatable, so the reset is the role-credential incident, not a key change.
  - holder of the current signing key — not bounded by anything here.
- Acceptance: each "verified" clause has a failing case and the all-pass twin; the own kid is
  never looked up in the archive; a miss followed by the key appearing resolves without a
  restart; two keys on the latest date → the own-kid one, count 2; a non-manifest key that
  sorts last is not `latest`.

### C4 — Publisher run protocol

`src/workers/audit-anchor-publisher.ts`. `runCadence(boundary)` keeps its signature;
`CadenceOutcome` keeps its kinds, `published` gains `adopted: boolean`. `PublisherConfig`
loses `signingKeyKid`. Deleted: `SETTING_PREVIOUS_MANIFEST`, `SETTING_LAST_PUBLISHED_BOUNDARY`,
`isBoundaryPublished`, `AttemptGate.already_published`, `previousManifestSchema` (SC3 for the
rows). `claimAttempt` returns `no_tenants | counted`.

Definitions, for boundary `B` (UTC date `d`):
- *published high-water* `H` = `MAX(last_published_at)` over **all** anchor rows, mapped to
  its cadence boundary (none when no row has a value); *settled* = `H ≥ B`.
- The value a publish writes to `last_published_at` is the wall clock clamped into
  `[B, B + cadence)`, so it always maps to `B` — a run that crosses into the next boundary
  does not write a value that maps past its own object.
- *ours* = `latest` signed under the own `kid` **and** carrying our `deploymentId`.

Steps. One 60 s bound covers all destination I/O of the run: (2), (4) and the backfill.
1. Database read, no lock: chain-enabled tenants and `H`.
2. `state = readPublishedState(primary)`, then: no chain-enabled tenant →
   `skipped_no_tenants` with `everChainEnabled` = an anchor row exists **or** the primary
   holds a manifest key (so deleting the anchor rows does not turn the skip healthy). That
   path uses the listing only — nothing is read or verified — and a listing error is row a.
   Every `skipped_no_tenants` outcome of the run, including one decided later in (3) or (4)
   because the set emptied meanwhile, takes `everChainEnabled` from this one expression.
   Otherwise the decision table.
3. `claimAttempt` (counts the run).
4. Publish transaction: advisory lock, step (1)'s reads again, `readPublishedState` again,
   the decision table again (so a second instance behind the lock skips), then act.

| # | Condition (first match) | Result | Reset |
|---|---|---|---|
| a | list/read error | fail `<name>_READ_FAILED:<code>` | fix access (C5) |
| b | `latest` unverifiable | fail `CADENCE_FAILED:PUBLISHED_OBJECT_UNVERIFIABLE` | archive the missing public key (C7); corrupt object → remove it (GitHub, filesystem) or restart the chain (below) |
| c | `latest.date` > the wall clock's boundary date | fail `…:PUBLISHED_OBJECT_AHEAD` | wait for the date, remove the object (GitHub, filesystem), or restart the chain |
| d1 | `H` > the wall clock's current boundary | fail `…:LAST_PUBLISHED_AHEAD_OF_CLOCK` | no publish wrote it: correct the database value (runbook SQL); never a chain restart |
| d2 | `latest.date` (or none) < date of `H` (equal is not behind; no `H` never matches) | fail `…:DESTINATION_BEHIND_DATABASE` | the destination's own evidence decides which side is wrong — on the Terraform bucket an object cannot vanish without a delete marker or the bucket-policy-change alarm, so with neither the database is wrong and a restart is not an option; on GitHub or the filesystem, the store's own history; `AUDIT_ANCHOR_PUBLISHED` rows are database content and corroborate only. Database wrong → correct it; destination lost → restore it where the operator can (filesystem backup), else restart the chain |
| e | `latest` under a foreign `kid` while `ownKidHasPublished` | fail `…:LATEST_UNDER_RETIRED_KEY` | a reverted key: rotate forward to a fresh one (never reuse a retired key). A planted name (C3) → role-credential incident, restart the chain |
| f | `latest.date` > `d` | `skipped_already_published` (warn `stale_boundary`) | — |
| g | `latest.date` = `d`, not ours | `skipped_already_published`; warn `published_by_other_identity` with `kidMatches`/`deploymentMatches`; one `AUDIT_ANCHOR_PUBLISH_FAILED` row `PUBLISHED_BY_OTHER_IDENTITY` carrying `anchoredAt`, per boundary per publisher instance | — |
| h | `latest.date` = `d`, ours, settled | `skipped_already_published` | — |
| i | `latest.date` = `d`, ours, not settled | *adopt* | — |
| j | `latest.date` < `d`, or none | *publish*, `previousManifest` = `latest` | — |

- Rows a–e in step (2) are uncounted (the scheduler's three in-process retries bound them, as
  for today's pre-count failures); in step (4) they are counted. Stage `before_upload`, no
  pause. Rows f–h never count. A skip is never the healthy line (SC4), so g repeating daily
  trips the existing absence alarm.
- Row g on legitimate operations: a restart on rotation day or after a DEPLOYMENT_ID change
  lands here for the rest of that day; and a commit lost just before such a change is never
  adopted, so the next day's publish reports `MISSING_PRIOR_CADENCE_PUBLICATION` although the
  object exists. The runbook's rotation and DEPLOYMENT_ID sections say both.
- *Publish*: build, sign, `primary.create`. `"exists"` → `readVerifiedManifest`; ours →
  continue as adopt with those bytes; not ours → fail `…:PUBLISHED_OBJECT_UNVERIFIABLE` or,
  verified under another identity, end as row g.
- *Adopt / after create*, in order: each secondary `create(primary bytes)`, `"exists"` → `read`
  and compare, different → fail `<name>_MIRROR_DIVERGED`; a secondary error →
  `<name>_UPLOAD_FAILED:<code>` (both stage `upload`, pause as today). Then the database
  writes: `lastPublishedAt` (clamped, above) and pause-clear on the anchor rows whose tenant
  tag is in the published manifest, whatever their current flag. Outcome `published`;
  `adopted` = the primary bytes were not written by this run. If no such row exists any more
  (the manifest's tenants were all deleted after a lost commit) nothing settles and that
  boundary's restarts are counted adopts up to the cap; the next boundary is unaffected.
- *Mirror backfill*, after the commit, on a `published` outcome, awaited by `runCadence` and
  inside the run's bound: per secondary, `list`, copy up to
  `AUDIT_ANCHOR_MIRROR_BACKFILL_MAX = 7` manifest keys the primary has and it lacks, newest
  first (planted old-dated keys cannot starve recent gaps). It is a byte copy: the bytes are
  not re-verified and existing mirror objects are not compared. A failure, or a `create` that
  answers `"exists"` with other bytes, is logged (`mirror_backfill_failed`) and does not
  change the outcome; the next publishing run continues.
- Rows emitted after the commit of a `published` outcome, each at most once per outcome:
  `AUDIT_ANCHOR_PUBLISHED` (existing fields + `adopted`, `genesis`); `AUDIT_ANCHOR_KEY_ROTATED`
  `{ oldKid, newKid, anchoredAt, artifactKey }` when the manifest's `kid` differs from the
  `kid` in its `previousManifest.uri` key; `AUDIT_ANCHOR_PUBLISH_FAILED`, every one carrying
  `anchoredAt`, with `MULTIPLE_MANIFESTS_FOR_DATE` when `latestDateKeyCount > 1` for the
  chained-to date, `OWN_PUBLIC_KEY_NOT_ARCHIVED` when it is not (a daily reminder until
  archived), `TENANT_DROPPED_FROM_MANIFEST` `{ count }` when a tenant tag of the previous
  manifest is absent from this one, `CHAIN_SEQ_REGRESSION` `{ count }` when a tag's
  `chainSeq` is below the previous one in the same epoch (both computed from the two
  manifests in hand; not on an adopted publish), and `MISSING_PRIOR_CADENCE_PUBLICATION` as
  today. A `published` outcome can recur for one boundary only when the database was rewound
  or a commit was lost.
- A previous manifest carrying another `deploymentId` is chained to and logged
  (`previous_manifest_deployment_changed`): the prefix holds one chain.
- *Restarting the chain* — the reset of last resort for b, c, d2, e, and the only way to
  change the primary destination (there is no seeding: on the Terraform bucket nobody but
  the publisher role can write a manifest key, and copying history out of a weaker store
  would lock it in unverified). Steps: a new prefix (or the new primary); the public keys
  archived there again; `last_published_at` cleared by the documented owner-role SQL; a
  signed chain-restart statement (C7) at the new location naming the old chain's last
  verified manifest, or stating that none survives. The genesis publish that follows carries
  `genesis: true` in its `AUDIT_ANCHOR_PUBLISHED` row. On S3 the triggers for b, c and e are
  reachable with the publisher role's credentials alone; the runbook rotates them first.
- Invariants (app-enforced)
  - No decision reads `system_settings` but the attempt count and the deployment-id boot
    check. Member set — `git grep -nE
    "SETTING_PREVIOUS_MANIFEST|SETTING_LAST_PUBLISHED_BOUNDARY|audit_anchor_previous_manifest|audit_anchor_last_published_boundary" -- . ':!docs/archive'`:
    `audit-anchor-publisher.ts`, `anchor-publisher-fixtures.ts`, `audit-anchor-publisher.test.ts`,
    `audit-anchor-publisher.metric-filter.test.ts`, `worker-policy-manifest.json`, `alerts.md`,
    the runbook, the threat model. Afterwards: docs describing the rows as inert, and
    `anchor-publisher-fixtures.ts`, which keeps the two key strings as test-only literals to
    plant and clean the legacy rows.
  - No skip without a verified object at the primary; no adoption of an object the own key
    did not sign.
- Control class: `fail-closed verification gate` (rows a–e, adoption) — with C3's
  per-destination qualifier: on a store whose writer can also delete or archive keys, d2 and
  e are tripwires. `detection or audit only`: the rows emitted with a publish, row g.
  Database-writer residuals, stated in the threat model, not prevented — alarmed: attempt
  count, advisory lock, `last_published_at` moved forward (d1/d2), every tenant's
  `auditChainEnabled` cleared (unhealthy skip once the primary holds a manifest); detected
  by a row only: one tenant's flag cleared (`TENANT_DROPPED_FROM_MANIFEST`).
- Forbidden patterns (non-test source)
  - `pattern: SETTING_PREVIOUS_MANIFEST|SETTING_LAST_PUBLISHED_BOUNDARY|isBoundaryPublished|previousManifestSchema — reason: database-decided publication state`
- Test seams: `hooks.inTx` (unchanged); `hooks.afterUpload` now runs after the primary create
  and all mirrors, before the database writes; conflicts are produced by a decorating
  destination whose `create` first writes a competing object through the real one. No new
  hook.
- Acceptance (integration: real Postgres with MinIO and with the filesystem destination;
  every case its own S3 prefix / temp dir, exact-set listing assertions)
  - Each table row. Every deny (a–e, g, diverged) asserts no object written, no anchor
    update, no secondary `create`, and has its allow twin.
  - Lost commit → retry `published`, `adopted: true`, one version, the next boundary chains
    to the adopted `sha256`; the chain advancing in between does not change the stored bytes.
  - Create conflict (decorating destination): ours → adopt, planted bytes kept, one version;
    garbage → fail closed; ours-shaped under a foreign archived kid → row g. Red proof: with
    the create made unconditional this case shows two versions while the lock case below
    stays green.
  - Two instances, one boundary: exactly one `published`; the second makes zero `create`
    calls (this pins the lock, not create-only).
  - Legacy `system_settings` rows in the exact formats the old code parsed: a marker at `B`
    with no object does not skip; a pointer naming an older manifest does not change
    `previousManifest`. Positive control recorded: the same fixtures against the pre-change
    publisher (scratch copy) do skip and do redirect.
  - `last_published_at ≥ B` with no object → row d2, not a skip; a value past the wall
    clock's boundary → d1; `H` on `latest`'s date → neither; no `H` with an empty primary →
    genesis.
  - A publish whose clock crosses the next boundary before the database write, then a normal
    run for the next boundary → `published` (red: the clamp removed → d2).
  - No chain-enabled tenant: empty primary and no anchor row → the healthy skip; a manifest
    key at the primary with the anchor rows deleted → not healthy.
  - A tenant disabled between two publishes → one `TENANT_DROPPED_FROM_MANIFEST` row; an
    unchanged set → none. Same pairing for `CHAIN_SEQ_REGRESSION`,
    `MULTIPLE_MANIFESTS_FOR_DATE` and `OWN_PUBLIC_KEY_NOT_ARCHIVED` (also: a `.pub` with
    another key's content counts as not archived), and for row g's row (once per boundary).
  - Backfill, filesystem to filesystem: a gap of 8 → the first run copies exactly the 7
    newest, the next the eighth (red: bound removed; order reversed); a secondary that throws
    during backfill → still `published`, `mirror_backfill_failed`, the next run completes.
  - The run's bound: the exact-boundary pair kept, a hanging `list` beside the hanging
    `create`. The non-writable filesystem primary still fails at `create` (its `list` is
    empty).
  - Upgrade: a key written twice by unconditional PUTs plus the legacy rows → the next
    boundary chains to the current version's `sha256`; a run for the same boundary adopts
    without a third version.
  - Tenant set changed after a publish (one disabled, one enabled) → restarts skip; a fourth
    boot run does not report `upload_cap_reached`.
  - Rotation on one publisher instance: old key not archived → row b; archived with the C7
    function → the retry chains to the old-kid manifest and emits one `AUDIT_ANCHOR_KEY_ROTATED`;
    reverting to the old key afterwards → row e.
  - Secondary: down for the boundary → run fails, primary one version; back the same day →
    retry adopts and mirrors; back three boundaries later → backfill fills the gap over the
    following runs; diverging → `_MIRROR_DIVERGED`. Empty new primary with a populated
    secondary → row d2.
  - Alarm path: each of a–e and diverged emits the `cadence_failed` line and matches that
    metric filter and no other; stale and ahead are driven from destination state; an adopted
    publish emits exactly one healthy line.
- Consumers of `CadenceOutcome`: the scheduler (`kind`), the cadence log line and its metric
  filters (no `_logType` renamed), the `AUDIT_ANCHOR_PUBLISHED` row.

### C5 — Publisher IAM

`infra/terraform/iam.tf`, `aws_iam_role_policy.ecs_audit_anchor_publisher_s3`: add
`s3:GetObject` on `<bucket>/<prefix>/*` and `s3:ListBucket` on the bucket with
`StringLike s3:prefix = "<prefix>/*"`.

- Acceptance (`audit-anchor-wiring.test.ts`, `audit-anchor-key-contract.test.ts`): the two
  statements pinned; the exported list-prefix string satisfies the rendered condition under
  StringLike semantics (red: no trailing slash; condition widened); `publicKeyArtifactKey` and
  `statementArtifactKey` outputs (both ops) match the bucket policy's break-glass paths and not
  the manifest pattern, and a manifest key the reverse; the old "publisher can also read"
  mutation is replaced by: GetObject on the bucket root, ListBucket without the condition, a
  write action beyond PutObject/PutObjectRetention.
- Upgrade order (apply Terraform, then deploy) in `infra/terraform/README.md`/`.ja.md` and
  `docs/operations/deployment.md`; without the grant the publisher fails closed (row a).
- The live grant is E1: manual-test row `blocked-deferred`. Cost to run: a real
  `terraform apply`. Worst case if wrong: row a on every run, alarmed within one cadence;
  nothing is published wrongly.

### C6 — Verifier rules and threat model

- `docs/security/audit-anchor-verification.md`: `kid` binding and its limit (C2); exit 19;
  https; GitHub key download; the one-version rule — a manifest key has one version, more is
  a write outside the protocol, *detectable by an operator running* `list-object-versions`
  (nothing runs it automatically), with the pre-upgrade exception; a manifest under a `kid`
  dated after the rotation away from it is untrusted; how to verify a statement (openssl, the
  manifest procedure with the statement `typ`), and that a rotation statement shows
  continuity only when the old key was not compromised.
- `docs/security/audit-chain-threat-model.md`: the database-write adversary (prevented /
  residual and alarmed / out of reach), the per-destination table of C3, SC1 and SC5 as
  stated limits.

### C7 — Operator scripts (#950)

`src/lib/audit/anchor-destinations/from-env.ts` (new, side-effect free):
`buildDestinationsFromEnv(env)`, used by `scripts/audit-anchor-publisher.ts` and the new
script. `scripts/audit-anchor-keys.ts`: exported `run(argv, deps): Promise<number>` with
injected destinations and output streams, behind a main guard; one option table per
subcommand.

| npm script | Does |
|---|---|
| `audit-anchor-kid -- --key-file <path>` | prints `publicKey=` and `kid=`; with destinations configured, whether the key is archived |
| `audit-anchor-publish-pubkey -- (--key-file <path> \| --public-key <hex>) --confirm` | `create`s `public-keys/<kid>.pub` on every configured destination |
| `audit-anchor-rotation-statement -- --old-key-file <path> --new-public-key <hex> --out <file>` | signs `{ op: "rotation", oldKid, newKid, newPublicKey, issuedAt }` with the old key |
| `audit-anchor-chain-restart -- --key-file <path> (--previous-manifest <file> --previous-uri <uri> [--previous-public-key <path>] \| --previous-none) --out <file>` | verifies the previous manifest, computes its hash, signs `{ op: "chain-restart", previousChain: { uri, sha256 } \| null, issuedAt }` |
| `audit-anchor-publish-statement -- --file <file> [--public-key <hex>] --confirm` | `create`s the file's bytes at `statementArtifactKey(issuedAt day, op, signer kid)` |

- Statements are JWS with `typ` `AUDIT_ANCHOR_STATEMENT_TYP = "passwd-sso.audit-anchor-statement.v1"`
  (a manifest `verify` rejects them with `InvalidTypError`). Signing and publishing are
  separate so a publish that reached only some destinations is retried with the same bytes;
  `publish-statement` verifies the file's signature under its header `kid` (own key file not
  needed: the key comes from `--public-key` or the archive listing) before writing.
- The chain-restart statement needs the current signing key on the operator's host: the
  runbook does it on an ephemeral host and destroys the file, and in an incident pairs the
  restart with a rotation.
- A write prints the kid, the key and the destinations first and refuses without `--confirm`:
  on S3 it is irreversible and, for a public key, extends what the publisher will chain to.
  `"exists"` with identical bytes is success; with different bytes exit 1, nothing written.
- Key files: opened once, refused unless mode `0600`, size-bounded, strict 64-hex. No seed
  reaches stdout, stderr or argv.
- `audit-anchor-emit-rotation-event` is not implemented: the publisher emits the row (C4).
  `audit-anchor-rotation-advisory` is named `audit-anchor-rotation-statement`.
- Consumers: the publisher reads `public-keys/<kid>.pub` (C3); a human verifier reads a
  statement by C6's procedure; no code consumes a statement.
- Acceptance: `scripts/__tests__/audit-anchor-keys.test.ts` — per subcommand: argument
  errors, mode check with its allow twin, `--confirm` missing vs present, exists-identical vs
  exists-different, the seed absent from both streams (the public key present as the positive
  control), a statement failing manifest `verify`; a rotation and a chain-restart statement
  on one day land on different keys, the same file published twice succeeds, a different
  statement of the same op, day and signer exits 1 with a message naming the stored key;
  `chain-restart` refuses a previous manifest that does not verify and accepts
  `--previous-none`. One spawn test runs each `package.json` script string
  (`audit-anchor-kid` end to end on the C2 vector, the others to their argument error). The
  C4 rotation case archives through `run`.

### C8 — Runbook, operations docs, descriptions of the old protocol

- `docs/operations/audit-anchor-rotation-runbook.md`: rotation as it runs — archive the old
  and the new public key, statement, switch the key, restart the publisher, the next run
  chains and emits the event, retire the old key; "never reuse a retired key". Overlap and
  dual-tag text removed (SC2); the tag-secret section says the cutover's next publish reports
  every tenant once in `TENANT_DROPPED_FROM_MANIFEST`, as expected; "Chain-sequence
  regression" says the publisher now emits `CHAIN_SEQ_REGRESSION`; the restart section says a
  secondary kept in the configuration holds another object for the restart day and fails that
  day with `_MIRROR_DIVERGED` unless it is taken out of the configuration for that day. Sections for the C4 table's resets, restarting the chain,
  adding or changing the primary destination (a chain restart), telling which side is wrong
  under d2 (with the upgrade note: a `last_published_at` written by an earlier release in a
  run that crossed a boundary maps one boundary late and is corrected by the d1/d2 SQL), the
  DEPLOYMENT_ID change (the rest of that day skips by row g). Prerequisite stated: the
  operator role needs `s3:GetObject`/`s3:ListBucket` on the prefix for the scripts' compare,
  which this stack does not manage. Each step that waits for the publisher says to restart it
  when the three retries are spent.
- `docs/operations/alerts.md`, `docs/operations/deployment.md` (clone paragraph, upgrade
  order, dedicated GitHub repository), `scripts/checks/worker-policy-manifest.json` (`reason`,
  `idempotent`, `retryPolicy`, `poisonMessageHandling`, `modules`), `CLAUDE.md`,
  `src/workers/audit-anchor-scheduler.ts` header; comment-only: `infra/terraform/storage.tf`,
  `monitoring.tf`, `ecs.tf` where they name the marker, the pointer, `upload` or the old home
  of `buildManifestArtifactKey`.
- `docs/archive/review/audit-anchor-hardening-manual-test.md`:
  - the built publisher bundle against MinIO and the worktree database: first boot publishes
    (one version); restart → `skipped_already_published`; `last_published_at` rewound, restart
    → `published`, `adopted: true`, one version; then a recorded cleanup (the test tenant
    and its anchor row removed) and a check that no `last_published_at` remains, so the
    integration fixtures' precondition holds afterwards;
  - every fenced command of the runbook, extracted by a recorded command from a recorded
    blob id of the runbook, each with its own exit status, or `blocked-deferred (E1)`;
  - a statement verified by C6's openssl procedure;
  - outputs checked for key material before commit.
- Acceptance: one test over the runbook text — "Not yet automated" absent; the `npm run`
  names found include the five C7 scripts and `generate:audit-anchor-signing-key` (a floor,
  so zero matches fails); each is in `package.json`; each flag shown after `--` is in that
  subcommand's option table.

## Testing strategy

- Unit: key shapes, vectors (server + CLI), published state, the decision table on the
  in-memory destination (stateful; it passes C1's contract suite), scripts.
- Integration (`npm run test:integration`, worktree database, `ANCHOR_TEST_S3_ENDPOINT`): C1
  and C4 acceptance. Fixture contract: a fresh S3 prefix and temp dir per case, removed in a
  teardown registered at creation; `makePublisherConfig` takes the signing key and deployment
  id from the case and defaults `now` from the boundary; no test writes under a prefix another
  file lists. Database side: a precondition beside `assertOnlyChainEnabledTenants` fails,
  naming the tenant ids and the cleanup, when an anchor row outside the case's tenants has a
  `last_published_at`; anchor-row teardown is registered at tenant creation; the outbox
  helpers find and purge every publisher row by `anchoredAt`; each case archives its own
  public key by default (through C7's function) so `OWN_PUBLIC_KEY_NOT_ARCHIVED` appears only
  where a case asks for it. The two "absent marker" cases of
  `audit-anchor-publisher.integration.test.ts` are replaced by d2 and its allow twin.
- Every deny has its allow twin (RT10); each new guard is red-proven on a scratch copy (RT7).
- Mandatory: `npx vitest run`, `npx next build`, `scripts/pre-pr.sh`.

## Considerations & constraints

- Upgrade: existing manifests are under the current key and verify as they are. Deployments
  that never archived the current public key get the daily `OWN_PUBLIC_KEY_NOT_ARCHIVED` row
  until they do.
- S3 cost: one LIST (≤ 3 pages at 7 years) and one GET per step.

### Scope contract

- **SC1** — bucket-policy `s3:if-none-match` enforcement against a compromised publisher
  role. Needs a real-AWS apply (E1) and a `storage.tf` change during #1020. Follow-up issue
  filed with the PR.
- **SC2** — dual-signing and dual-tag overlap. Not implemented; the runbook documents the
  cutover. Follow-up issue only if an overlap is wanted.
- **SC3** — deleting the inert `system_settings` rows (an RLS-bypassing data migration).
- **SC4** — alarms and `monitoring.tf` resources: unchanged; a skip stays outside the healthy
  line; no alarm is added for the detection-only rows.
- **SC5** — GitHub and filesystem stores do not separate writers or prevent deletion; C3
  states what that leaves unbounded.
- **SC6** — the runbook's `aws …` and `terraform …` lines are not run here (E1); recorded as
  `blocked-deferred` in the manual test, to be run by the operator.

## User operation scenarios

1. Daily run: list → latest is yesterday's → publish → one version.
2. Task killed between the PUT and the commit: the boot run adopts and settles.
3. Operator rotates and forgets to archive the old public key: row b (alarmed);
   `audit-anchor-publish-pubkey` with the old key, then a publisher restart, publishes and
   emits `AUDIT_ANCHOR_KEY_ROTATED`.
4. A database writer sets the legacy rows or rewinds `last_published_at`: nothing published
   changes; moving it forward fails closed (d1 or d2), alarmed, and the reset is correcting
   the value — not a chain restart.
5. A clone pointed at the same prefix: whichever publishes second skips (row g) and its
   absence alarm fires.
6. S3 + GitHub, GitHub down for three days: those runs fail after the S3 create (one version
   each); once GitHub is back the backfill fills the gap.
7. GitHub-only deployment adds S3: S3 becomes the primary and is empty → d2. The runbook's
   chain restart starts a new chain at S3 with a statement naming the GitHub chain's last
   manifest.
8. Auditor verifies across a rotation: `audit-verify --prior-manifest … --prior-public-key …`.

## Carried-Forward Plan Findings

Round 3 ended saturated (no Critical or Major; see the review file). These Minor findings
are only reachable by building the implementation; none is deferred out of this PR — each is
done in Phase 2, and the line says what settles it.

### T3-1 Minor — per-process state should be per publisher instance — Accepted (Phase 2)
- **Anti-Deferral check**: not a deferral — implemented in this PR (cost under 30 minutes).
- **Justification**: the row-g dedupe, the archived-key match and the foreign-key cache live
  on the publisher instance (or the object handed to `readPublishedState`), never at module
  level. Settled by: the paired cases passing in either order in one process.
- **Orchestrator sign-off**: in scope of C3/C4; checked at Phase 2-4.

### T3-2 Minor — two guards without a reddening case — Accepted (Phase 2)
- **Anti-Deferral check**: not a deferral — implemented in this PR.
- **Justification**: add "stale at first look, `uploaded` at the re-read → `"exists"`, zero
  DELETEs" (fake scripts asset state per request; age via `created_at`, no sleep) and
  "`publish-statement` on a tampered statement and on a manifest JWS → refused, zero
  creates", each with its valid twin. Settled by: each guard's red proof finding a failing test.
- **Orchestrator sign-off**: in scope of C1/C7.

### T3-4 Minor — zero-tenant cells — Accepted (Phase 2)
- **Anti-Deferral check**: not a deferral — implemented in this PR.
- **Justification**: the healthy zero-tenant case runs at unit level on the in-memory
  destination (an integration database may hold other anchor rows); "manifest key present,
  anchor rows deleted → not healthy" stays in integration; "no tenant × listing fails → row
  a" is added. Settled by: those three cases.
- **Orchestrator sign-off**: in scope of C4.

### T3-5 Minor — implicit boundary cells — Accepted (Phase 2)
- **Anti-Deferral check**: not a deferral — implemented in this PR.
- **Justification**: the bound is one deadline armed at the run's first destination call
  (named in the test); a clock before `B` writes `B`; `H` equal to the wall clock's boundary
  is not d1; an equal `chainSeq`, or a lower one in a higher epoch, emits no regression row;
  an adopted publish emits no drop/regression row. Settled by: one assertion each.
- **Orchestrator sign-off**: in scope of C4.

### T3-6 Minor — literal seed in the vector file vs secret scanning — Accepted (Phase 2)
- **Anti-Deferral check**: not a deferral — implemented in this PR.
- **Justification**: the vector seed is the low-entropy constant the existing golden vector
  uses (`Buffer.alloc(32, 0x42)`), and gitleaks is run on the file. Settled by: a green
  gitleaks run in `scripts/pre-pr.sh`.
- **Orchestrator sign-off**: in scope of C2.

## Implementation Checklist

Batches (A first; B and C after A; D last):

- **A — C1, C2**
  - `src/lib/constants/audit/audit.ts` (`AUDIT_ANCHOR_ARTIFACT_MAX_BYTES`, `AUDIT_ANCHOR_STATEMENT_TYP`,
    `AUDIT_ANCHOR_MIRROR_BACKFILL_MAX`), `cli/src/constants/audit-anchor.ts`
  - `src/lib/audit/anchor-artifact-keys.ts` (new) + unit test
  - `src/lib/audit/anchor-manifest.ts` + `anchor-manifest.unit.test.ts`
  - `src/lib/audit/anchor-destinations/{destination,s3-destination,filesystem-destination,github-release-destination}.ts`,
    `in-memory-destination.ts` (new, test support), `from-env.ts` (new), their unit tests,
    one contract suite; `audit-anchor-s3-destination.integration.test.ts`,
    `audit-anchor-github-release-destination.integration.test.ts`
  - `cli/src/commands/audit-verify.ts`, `cli/src/index.ts`, `cli/src/__tests__/{unit,integration}/audit-verify*.test.ts`,
    `cli/src/__tests__/fixtures/audit-anchor-vectors.json` (new), `.github/workflows/ci.yml`
    (`app` filter entry) + the test that pins it
  - `src/__tests__/infra/audit-anchor-key-contract.test.ts`
- **B — C3, C4**
  - `src/lib/audit/anchor-published-state.ts` (new) + unit test
  - `src/workers/audit-anchor-publisher.ts`, `audit-anchor-publisher.test.ts`,
    `audit-anchor-publisher.metric-filter.test.ts`, `src/workers/audit-anchor-scheduler.ts` (header)
  - `scripts/audit-anchor-publisher.ts` (uses `from-env.ts`, no `signingKeyKid`)
  - `src/__tests__/db-integration/anchor-publisher-fixtures.ts`, `audit-anchor-publisher.integration.test.ts`,
    `audit-anchor-publisher-s3.integration.test.ts`, `audit-anchor-fail-closed.integration.test.ts`,
    `anchor-publisher-key-load.integration.test.ts`
- **C — C5, C7**
  - `infra/terraform/iam.tf`; `src/__tests__/infra/audit-anchor-wiring.test.ts`
  - `scripts/audit-anchor-keys.ts` (new) + tests, `package.json` (five scripts)
- **D — C6, C8**
  - the docs listed in C6/C8, `scripts/checks/worker-policy-manifest.json`, `CLAUDE.md`,
    Terraform comment-only edits, the runbook test, the manual-test record

Reuse (do not reimplement): `jcsCanonical` (`@/lib/audit/audit-chain`), `errorLogFields`
(`@/lib/logger/error-fields`), `pgErrorCode`, `MS_PER_*` (`@/lib/constants/time`),
`currentCadenceBoundary`, `joinS3Key`, `computeTenantTag`, `setBypassGucs`/`advisoryXactLock`,
the CLI's same-fd key-file read, `z.treeifyError`.

Patterns: failure reasons are tokens (tenant-readable metadata), every worker log line
carries `_logType`, time constants are computed from `MS_PER_*`, 3+ related string literals
become a const object.

CI parity: `bash ~/.claude/hooks/extract-ci-checks.sh` yields 21 gates; the anchor-relevant
ones (vitest, integration with MinIO, terraform validate/test, gitleaks, CLI tests) are run
by `scripts/pre-pr.sh` or by hand in Step 2-4. `terraform validate/test` runs offline (no AWS
credentials) and is not E1.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Destination interface | locked |
| C2 | Key shapes, `kid` binding, strict inputs | locked |
| C3 | Published state read from the primary | locked |
| C4 | Publisher run protocol | locked |
| C5 | Publisher IAM read grant | locked |
| C6 | Verifier rules and threat model | locked |
| C7 | Operator scripts | locked |
| C8 | Runbook, operations docs | locked |
