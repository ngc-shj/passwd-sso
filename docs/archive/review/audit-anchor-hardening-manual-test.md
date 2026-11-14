# Manual Test Record: audit-anchor-hardening

Run on 2026-11-14 (JST) in the branch's worktree, against the worktree's own database
(`passwd_sso_wt_949_950`) and the local MinIO (the image digest CI uses), bucket
`anchor-test-object-lock`, a fresh prefix per scenario. Throwaway keys from
`npm run generate:audit-anchor-signing-key`; no key material appears below or in the kept
logs (checked by grepping the logs and statements for both seeds: 0 files).

Runbook under test: `docs/operations/audit-anchor-rotation-runbook.md`, blob
`cb73bf56b0c5eaaf9fac21316f0c209ba673b37d` (`git hash-object` of the file committed with this
record). Its commands were extracted with

```
awk '/^[[:space:]]*```(bash|sql)/{f=1; next} /^[[:space:]]*```/{f=0} f' docs/operations/audit-anchor-rotation-runbook.md
grep -noE '`npm run [a-z:-]+[^`]*`' docs/operations/audit-anchor-rotation-runbook.md
```

81 lines inside `bash`/`sql` fences that are neither blank nor a `#` / `-- ` comment (the
awk output piped through `grep -cvE '^\s*(#|-- |$)'`; continuation lines count), and one inline
`npm run` span — so an empty extraction would show as 0, not as a clean table. The runs in
sections 2 and 3 were made before the code-review fixes; the fixes changed two output strings,
each noted in its row (`publish-pubkey`'s "already held" line, and the quoting of the `typ`
in the CLI's error), and the behaviour on those paths is covered by
`scripts/__tests__/audit-anchor-keys.test.ts` and the CLI vector tests.

## Pre-conditions

- Postgres with the worktree database migrated; MinIO at `http://127.0.0.1:9000` with a KMS
  key; no worker connected to this database.
- The publisher connects as `passwd_anchor_publisher` (NOSUPERUSER, NOBYPASSRLS).
- S3 reached through `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_REGION`, `AUDIT_ANCHOR_DESTINATION_S3_BUCKET`, `AUDIT_ANCHOR_DESTINATION_S3_PREFIX`.
- One chain-enabled tenant with an anchor row and no `last_published_at`.

## 1. The built publisher bundle

Built exactly as the Dockerfile does (`npx esbuild scripts/audit-anchor-publisher.ts --bundle …
--outfile=dist/audit-anchor-publisher.js`), run with `node dist/audit-anchor-publisher.js` and
stopped by SIGTERM after its boot run. Ready signal: the `audit-anchor-publisher.cadence` line.

| # | Step | Expected | Observed |
|---|------|----------|----------|
| 1.1 | First boot, empty prefix (own public key archived) | `published`, one version | `kind: published, adopted: false`, `cadence_healthy`; key `2026-11-14.kid-<kid>.jws` 1 version; `AUDIT_ANCHOR_PUBLISHED` row `genesis: true` |
| 1.2 | Restart, same boundary | skip, no write | `kind: skipped_already_published`; still 1 version |
| 1.3 | `last_published_at` set to NULL, restart | adopt the stored object | `kind: published, adopted: true`, same `manifestSha256`; still 1 version, 0 delete markers |
| 1.4 | Object stored but the commit lost (a run whose database write was refused, below), then a run as the publisher role | adopt | `kind: published, adopted: true`; 1 version |
| 1.5 | Restart under a **new** signing key the same day | skip, other identity | warn `published_by_other_identity` (`kidMatches: false, deploymentMatches: true`), `kind: skipped_already_published` |

Found while running 1.1: started with `DATABASE_URL` (the app role, which by design holds no
UPDATE on `audit_chain_anchors`) the publisher stored the object and then failed its commit —
`COMMIT_FAILED_AFTER_UPLOAD:42501`, three times, then `upload_cap_reached` with one
`UPLOAD_ATTEMPT_CAP_REACHED` row. That is the lost-commit state 1.4 starts from, and the cap
behaving as documented. The publisher role's column grants (`last_published_at`,
`publish_paused_until`, `updated_at`) cover the new writes; no grant changed.

## 2. Runbook commands

| Runbook command | Run | Result |
|---|---|---|
| `npm run generate:audit-anchor-signing-key -- --out <file>` | local | exit 0; file mode 600, 65 bytes |
| `npm run audit-anchor-kid -- --key-file <file>` | local | exit 0; `publicKey=…`, `kid=audit-anchor-<16 hex>`; with a destination configured, `archived[s3-object-lock]=yes` after 2.3 |
| `npm run audit-anchor-publish-pubkey -- --key-file <old> --confirm` | local (MinIO) | without `--confirm`: prints kid, key, artifact, destination and refuses, exit 2. With it: `s3-object-lock: created`, exit 0. Again: reported as already held, exit 0 (the line reads `exists (same key)` since code review F-1) |
| `npm run audit-anchor-publish-pubkey -- --public-key <hex> --confirm` | local (MinIO) | `created`, exit 0 |
| `npm run audit-anchor-rotation-statement -- --old-key-file … --new-public-key … --out rotation.jws` | local | exit 0; header `typ: passwd-sso.audit-anchor-statement.v1`, `kid` = old kid; payload `{issuedAt, newKid, newPublicKey, oldKid, op: "rotation"}` |
| `npm run audit-anchor-publish-statement -- --file rotation.jws --confirm` | local (MinIO) | `created` at `key-rotation-20261114.rotation.kid-<old kid>.jws`, exit 0; again: `exists (identical)`, exit 0 |
| `npm run audit-anchor-chain-restart -- … --previous-manifest … --previous-uri … --out restart.jws` | local | exit 0; `previousChain.sha256` equals the `manifestSha256` the publisher logged for that manifest |
| `npm run audit-anchor-chain-restart -- … --previous-none --out …` | local | exit 0; `previousChain=none` |
| `npm run audit-anchor-publish-statement -- --file restart.jws --confirm` | local (filesystem destination, batch D) | exit 0 |
| SQL: correct `last_published_at` (d1/d2 reset) | local, as a NOBYPASSRLS role | without the three `SET LOCAL` lines: `SELECT 0`, `UPDATE 0`; with them: `SELECT 1`, `UPDATE 1` (rolled back) |
| SQL: clear `last_published_at` (chain restart) | local, as a NOBYPASSRLS role | without the GUCs `UPDATE 0`; with them `UPDATE 1` (rolled back) |
| SQL: read the publisher's audit rows (`BEGIN READ ONLY; SET LOCAL app.tenant_id …`) | local, as `passwd_app` (NOBYPASSRLS) | runs, `SELECT 0` — the worktree runs no outbox worker, so `audit_logs` holds no publisher row; the rows themselves were read from `audit_outbox` in section 1 |
| SQL: change `audit_anchor_deployment_id` (DEPLOYMENT_ID change) | local, as a NOBYPASSRLS role | without the three `SET LOCAL` lines `UPDATE 0`; with them `UPDATE 1` (rolled back) |
| `npm run generate:audit-anchor-tag-secret -- --out <file>` (inline) | local | exit 0; file mode 600, 65 bytes |
| `(umask 077; aws secretsmanager get-secret-value … \| jq -r '.AUDIT_ANCHOR_SIGNING_KEY' > old-key.hex)` | local half only | `umask 077` + `jq -r` on a JSON document of that shape gives a mode-600, 65-byte file that `audit-anchor-kid` accepts (exit 0). The `aws secretsmanager` half: `blocked-deferred (E1)` |
| `export …=$(terraform output -raw audit_anchors_bucket_name)` / `audit_anchor_s3_prefix` / `app_secrets_arn` | not run | `blocked-deferred (E1)`. Static: the three output names exist in `infra/terraform/outputs.tf` |
| SQL: record a version 1 manifest as settled (`LEGACY_MANIFEST_UNSETTLED` reset) | local, rolled back | parses and runs under the bypass GUCs; matched 0 rows on the empty worktree database (syntax and admission only) |
| The bucket policy's `DenyUnconditionalPut` (C9) on real S3 | not run | `blocked-deferred (E1)` — MinIO evaluates no bucket policy here. Static: `audit-anchor-wiring.test.ts`, `audit-anchor-key-contract.test.ts`. Worst case if the statement is wrong: every create is refused (`s3-object-lock_UPLOAD_FAILED:AccessDenied`), alarmed; nothing is published wrongly |
| `aws s3api head-object …` | not run | `blocked-deferred (E1)` — real AWS. Local equivalent: the archived `.pub` is 65 bytes (64 hex + newline), 1 version |
| `aws s3api get-object-retention …` | not run | `blocked-deferred (E1)`. COMPLIANCE retention on `create` is asserted on MinIO by `audit-anchor-s3-destination.integration.test.ts` |
| `aws s3api list-object-versions …` (two places) | not run | `blocked-deferred (E1)`. Local equivalent via the SDK: every key in section 1 has 1 version, 0 delete markers |
| `aws s3api get-object-lock-configuration …` | not run | `blocked-deferred (E1)` |
| `aws ecs update-service …` | not run | `blocked-deferred (E1, E3)` |
| `terraform apply` (the IAM read grant; a prefix change) | not run | `blocked-deferred (E1)`. Static: `audit-anchor-wiring.test.ts`, `audit-anchor-key-contract.test.ts` |

`blocked-deferred (E1)` — cost to run: a real AWS environment with the anchors bucket and the
break-glass role. Worst case if a line is wrong: an operator command fails with an AWS CLI
error during a rotation; nothing is published wrongly, since every write goes through the
create-only scripts. To be run by the operator on the first real rotation (SC6).

## 3. Verifier

| Step | Expected | Observed |
|---|---|---|
| openssl procedure of `audit-anchor-verification.md` on `rotation.jws` with the old public key | verifies | `Signature Verified Successfully`, exit 0 |
| `passwd-sso audit-verify --manifest <published manifest> --public-key <right key>` | PASS | `PASS`, exit 0 |
| same with another valid key | kid mismatch | `JWS kid … does not name the supplied public key (…)`, exit 19 |
| `audit-verify` on a statement | not a manifest | `Invalid JWS typ: passwd-sso.audit-anchor-statement.v1; expected passwd-sso.audit-anchor.v1`, exit 11 (as run; the CLI now prints the value JSON-quoted — `Invalid JWS typ: "passwd-sso.audit-anchor-statement.v1"; …` — same exit code) |

## 4. Adversarial scenarios

Run as integration tests on real Postgres + MinIO (all green; see the deviation log for the
red proofs), listed here because they are the reason for the change:

- A `system_settings` marker at the boundary with no object does not skip; a pointer naming an
  older manifest does not redirect. The same rows make the pre-change publisher do both
  (positive control on a scratch copy of `dcc1eded9`).
- `last_published_at` moved forward with no object fails closed (`DESTINATION_BEHIND_DATABASE`
  / `LAST_PUBLISHED_AHEAD_OF_CLOCK`), never a skip.
- A competing object written under the publisher's key name between its listing and its
  create: one signed by the own key is adopted, garbage fails closed; with the create made
  unconditional the same case shows two versions.
- A latest manifest under a key that was not archived fails closed; archived, the next run
  chains and emits one `AUDIT_ANCHOR_KEY_ROTATED`; reverting to the retired key fails closed.

Not exercised anywhere (E1/E2): the IAM read grant and the bucket policy on real S3, S3's
`409 ConditionalRequestConflict`, GitHub's real asset-upload behaviour.

## Rollback

All test state was removed: the test tenant, its anchor row, the publisher's `system_settings`
rows and its `audit_outbox` rows (set `FAILED`, then deleted — a `PENDING` row cannot be
deleted). Check afterwards: 0 anchor rows, 0 `audit_anchor*` settings, 0 anchor outbox rows,
0 anchor rows with a `last_published_at`. The MinIO objects are COMPLIANCE-locked and stay
under their random prefixes.

Rolling the release back is not a test rollback: see `docs/operations/deployment.md` — a
pre-protocol publisher must not run once this one has published.
