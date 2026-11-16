# Plan: anchor-workers-compose-k8s (issue `#946`)

Branch: `feat/anchor-workers-compose-k8s` (cut from `origin/main` 27968fb28).
Revision 7 (after plan-review rounds 1-6; dispositions in `-review.md`).

## Project context

- Type: `mixed` (deployment manifests, env-schema change, vitest pins, a static
  check step, docs).
- Test infrastructure: unit + integration + E2E + CI/CD.
- Verification environment constraints:
  - **E1** — no Kubernetes cluster, no `kubectl`/`kubeconform` on the dev host.
    k8s manifests: parse + structural assertion (`verifiable-CI`). Apply against a
    cluster and schema validation: `blocked-deferred` (Anti-Deferral in review, T10).
  - **E2** — dev Postgres is shared; no extra compose services may be started
    against it without asking. Compose: `docker compose … config` renders
    (`verifiable-local` + `verifiable-CI`, C7) and the bundle boot smoke
    (`verifiable-local` + CI, C8). Real `up` of the new services:
    `blocked-deferred` unless the user approves.
  - **E3** — no AWS account; the S3 destination itself is covered by the existing
    MinIO tests, untouched here.

## Objective

Run `audit-anchor-publisher` and `audit-chain-verify-worker` in
`docker-compose.workers.yml` and `infra/k8s/`, with the env each gets on ECS, keep
the signing material out of every other container, and make both properties
tested invariants.

## Derived inputs

- Env sets: `scripts/checks/worker-bundle-smoke.json` (pinned to `ecs.tf` by
  `worker-bundle-smoke-map.test.ts`). Publisher literals: `AUDIT_ANCHOR_PUBLISHER_ENABLED=true`,
  S3 bucket/prefix and `AWS_REGION` (Terraform refs); secrets: its DB URL, signing
  key, tag secret, `DEPLOYMENT_ID`. Verify worker: `AUDIT_CHAIN_VERIFY_DATABASE_URL` only.
- Stop timeout and single-replica stop-before-start: `ecs.tf`
  (`stopTimeout`, `deployment_maximum_percent = 100` +
  `deployment_minimum_healthy_percent = 0`), read with hcl-subset (moved to `scripts/checks/lib/hcl-subset.ts`, see C7).
- Worker requirements (code): publisher schema requires keys + `DEPLOYMENT_ID` when
  enabled and its role URL in production; verify worker requires its URL in
  production; runner image sets `NODE_ENV=production`; publisher writes to disk
  only in the filesystem destination (`filesystem-destination.ts`).

## Design

### Compose: one `.env`, blanked per service (X1)

Every compose service with `env_file: .env` receives all of `.env`. Rather than a
second env file (which `init:env`, `.env.example`, the app schema and the anchor key
CLI all contradict), every such service overrides, in its own `environment:`, each
key of the **withheld set** with an empty value — or, for the one service that is
its legitimate consumer, with its value. `environment:` wins over `env_file:` in
compose, so the container holds `""`.

Withheld set W, derived once in `scripts/checks/lib/withheld-env.ts` (imported by C3, C7
and the C6 pin; not hand-listed):
- (a) every `scripts/env-allowlist.ts` entry with `secret: true` (today: the seven
  `PASSWD_*_PASSWORD`, `JACKSON_API_KEY`, `SENTRY_AUTH_TOKEN`, and the three new
  `AUDIT_ANCHOR_AWS_*`) — none is read by the app or a worker (N2);
- (b) other principals' DB URLs: `envObject` keys matching `_DATABASE_URL$` except
  `DATABASE_URL` (incl. `MIGRATION_DATABASE_URL`);
- (c) publisher-only secrets: names the ECS publisher task receives as `secrets`
  that the ECS app task does not, minus (b) and `DEPLOYMENT_ID`; plus
  `AUDIT_ANCHOR_DESTINATION_GH_TOKEN` and its alias `GITHUB_TOKEN` (both read by
  `from-env.ts`; pinned by a test that `from-env.ts` reads each) (N1).
- Floor (U6): W ⊇ {`AUDIT_ANCHOR_SIGNING_KEY`, `AUDIT_ANCHOR_TAG_SECRET`,
  `GITHUB_TOKEN`, `PASSWD_SUPERUSER_PASSWORD`, `OUTBOX_WORKER_DATABASE_URL`};
  a new `secret: true` allowlist entry enters W with no other edit (red case).

Legitimate holders (the per-(service,key) table, same module, U1): a service that
loads `.env` may hold a W key with a value only when that key is its own
smoke-map DB URL. Services that do not load `.env` (`db`, `jackson`, `migrate`,
`redis`, the publisher, the verify worker) receive W values only by interpolation,
which is their declared purpose (initdb role passwords, their own URL); the only
substring check is that the publisher-only (c) sentinels appear in no value of any
service except `audit-anchor-publisher`. Role-password sentinels are additionally
bound per service (P1): `app`→`PASSWD_APP_PASSWORD`, each worker→its role password
(the role is the user in its smoke-map URL), `jackson`→`PASSWD_JACKSON_PASSWORD`,
`migrate`→`PASSWD_SUPERUSER_PASSWORD`, `db`→all; C7 checks role-password sentinels
by substring against that set, and C3 asserts each own-URL's user equals the
smoke-map URL's user (red case: a worker URL rewritten to the superuser). The
smoke-map users are themselves pinned to `scripts/checks/db-grants-manifest.json`
`ROLEATTR` rows: all three rows present with `rolsuper` false, `rolbypassrls`
false, `rolcanlogin` true — an absent row fails (sec-R1); the smoke-map users are
pairwise distinct and none is the user of the app's `DATABASE_URL` in
`docker-compose.yml` (sec-R2) — extracted with an anchored `^postgresql://([^:@/]+):`
pattern (raw text holds `${…:?…}`, which `new URL()` misparses); no match fails
the check (red case: unparseable app URL) (sec-S1). Red cases: a smoke-map user rewritten to
`passwd_user` (message names the missing rows) and to `passwd_app` (Q2).

The publisher does **not** load `env_file: .env`. It gets exactly its ECS names by
interpolation: `${AUDIT_ANCHOR_SIGNING_KEY:?…}`, `${AUDIT_ANCHOR_TAG_SECRET:?…}`,
`${DEPLOYMENT_ID:?…}`, its role URL from `${PASSWD_ANCHOR_PUBLISHER_PASSWORD:?…}`,
`AUDIT_ANCHOR_PUBLISHER_ENABLED=true`, `DATABASE_URL=`; destination names
pass-through `${…:-}` (S3 bucket/prefix, GH repo, FS path); GH token
`${AUDIT_ANCHOR_DESTINATION_GH_TOKEN:-}`; AWS credentials from publisher-specific
names `AWS_ACCESS_KEY_ID=${AUDIT_ANCHOR_AWS_ACCESS_KEY_ID:-}`,
`AWS_SECRET_ACCESS_KEY=${AUDIT_ANCHOR_AWS_SECRET_ACCESS_KEY:-}`,
`AWS_REGION=${AUDIT_ANCHOR_AWS_REGION:-}` (new allowlist entries; also in W(c) so
`app` holds `""` for them). The verify worker likewise does not load `.env`.

Consequences: `.env` stays the single source. `DEPLOYMENT_ID` reaches the
publisher and retention-gc by the same interpolation path: retention-gc gains
`DEPLOYMENT_ID=${DEPLOYMENT_ID:-}` in `environment:` (overrides its `env_file`),
so a shell export cannot split them (N3). `init:env` may keep writing the keys to
`.env`. The anchor key CLI reads destination names from `.env`; its AWS/GitHub
credentials come from the operator's shell or profile, never `.env` (N5). With the
`AUDIT_ANCHOR_AWS_*` names unset the publisher's empty `AWS_ACCESS_KEY_ID` makes the
SDK use its default chain (host instance role) — documented as intended, scoped by
the same policy as `iam.tf`.

App schema (C6): only the app schema (`envSchema`) drops `""`-valued W keys before
parsing (a preprocess over the input object driven by an exported
`APP_WITHHELD_ENV_KEYS`, pinned by test to W ∩ `envObject` keys). Worker schemas
are untouched, so an empty worker own-URL is still refused (N6). The production
destination check needs `GH_REPO` only (the token is the publisher's).
`emptyAsUnset` moves from `scripts/retention-gc-worker.ts` into `env-schema.ts` and
is reused, not duplicated (U2).

### k8s

- Publisher: `ServiceAccount` (`automountServiceAccountToken: false`, IRSA
  role-ARN placeholder annotation) + `Deployment` (`replicas: 1`,
  `strategy.type: Recreate`, `terminationGracePeriodSeconds` = ECS `stopTimeout`).
  Env names = ECS set exactly. Signing key + tag secret + role URL from Secret
  `audit-anchor-publisher` (publisher-only); `deployment-id` from shareable Secret
  `passwd-sso-deployment`; bucket/prefix/region from ConfigMap
  `audit-anchor-publisher`; `AUDIT_ANCHOR_PUBLISHER_ENABLED: "true"` literal.
  Other destinations / non-EKS credentials: operator Kustomize patch (documented).
- Verify worker: `Deployment`, Secret `audit-chain-verify-worker-db`, default
  rolling update (pool max 2 × 2 pods ≤ CONNECTION LIMIT 10).
- Real secret isolation on k8s is namespace RBAC; documented, not claimed by tests.

## Contracts

### C1 — Compose services (`docker-compose.workers.yml`)
- `audit-anchor-publisher`, `audit-chain-verify-worker`: `build:` as the existing
  workers, `command: ["node", <smoke-map bundle>]`, `restart: unless-stopped`,
  `logging: *default-logging`, `networks: [internal]`, `depends_on` as existing.
- I1.1 Neither loads `.env` (any `env_file` spelling).
- I1.2 Role URL, signing key, tag secret, `DEPLOYMENT_ID`, role passwords use only
  `${NAME:?…}` (not `:-`, `?`, bare); `DATABASE_URL=` present on both.
- I1.3 Publisher env names = ECS names ∪ the declared compose pass-throughs
  (`DATABASE_URL`, GH repo/token, FS path, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`) exactly; `AUDIT_ANCHOR_PUBLISHER_ENABLED=true`. Red case:
  `GITHUB_TOKEN` added to the publisher (its alias fall-through is then excluded by
  the gate, not by omission) (Q1).
  Verify worker env names = `{AUDIT_CHAIN_VERIFY_DATABASE_URL, DATABASE_URL}`.
- I1.4 Judged per service NAME across all compose files (U3): if any fragment of a
  service loads `.env`, the merged service must define every key of W as an
  explicit empty string (`KEY=` / `KEY: ""`; bare `- KEY` and `KEY:`/null pass the
  `.env` value through and count as holding it, N4) — or valued only where it is
  that service's smoke-map DB URL; and no fragment of it may set a W key to a value.
- I1.5 Publisher `stop_grace_period` ≥ ECS `stopTimeout` s, parsed as a Go duration
  (`120s`, `2m`, `2m0s`) (U5).
- I1.7 retention-gc `DEPLOYMENT_ID=${DEPLOYMENT_ID:-}` (same path as the publisher),
  in `docker-compose.workers.yml` only: the dev override's tsx workers also read
  `/app/.env.local` via `loadEnv()`, which a container-set value would shadow (P3).
  W blanking in dev shadows `.env.local` too, harmless because no dev worker reads
  a W key; noted in the override and CLAUDE.md env notes.
- I1.6 No other compose file defines these two service names.
- Control class: `fail-closed verification gate` over the repo's production compose
  files (base, workers, logging, ha). In the dev override the workers bind-mount
  `.:/app`, so `/app/.env` stays readable and blanking only shapes `process.env`
  there — I1.4 still applies (keeps dev ≡ prod env shape) but claims no isolation
  for dev (N6-func);
  adjudication authority: the YAML loader shared with `check-compose-log-caps`
  (C3) and compose's own render (C7). Not a boundary against an operator who edits
  the files or runs another `-f` set.
- Forbidden: `pattern: (SIGNING_KEY|TAG_SECRET|_PASSWORD)(:-|\?)[^:]` in
  `docker-compose.workers.yml` — reason: optional/empty-accepting interpolation.
- `:?` messages plain text (no `*`/`&`, `compose-env-scan` anchor regex).

### C2 — k8s manifests (`infra/k8s/`)
- I2.1 Command `["node", <bundle>]`; startup/liveness probes the same bundle with
  `--validate-env-only`.
- I2.2 For the two new manifests, env names = ECS set exactly; ECS secret names via
  `secretKeyRef`; ECS literal values equal **strings** (`typeof === "string"`).
  Existing two: DB-URL name from `secretKeyRef`, no `DATABASE_URL`.
- I2.3 (repo hygiene) the Secret holding `signing-key`/`tag-secret` is referenced
  by no other workload in `infra/k8s/**` (`secretKeyRef`, `envFrom`, `volumes`,
  `projected`).
- I2.4 For tasks whose ECS service is stop-before-start (derived): `replicas: 1`,
  `strategy.type: Recreate`, grace ≥ `stopTimeout`.
- I2.5 Hardening equal to the existing manifests (non-root, read-only rootfs,
  no privilege escalation, caps drop ALL, pod + SA automount false, image
  placeholder).
- I2.6 selector ⊆ template labels; `serviceAccountName` names a ServiceAccount
  document in the same file.
- Control class: `fail-closed verification gate` (parser-adjudicated) for
  I2.1/2.2/2.4–2.6; I2.3 `detection only` (repo hygiene, RBAC is the control).

### C3 — `src/__tests__/infra/worker-deploy-parity.test.ts`
- Member set: tasks of the smoke map. For each: exactly one compose service in
  `docker-compose.workers.yml` and exactly one Deployment in `infra/k8s/**`
  running its bundle; a `dist/` bundle in any unmodelled kind/key/`args`, a
  compose service or workload running a bundle not in the map, or a non-`.yaml`
  file under `infra/k8s/` fails.
- Normalises compose spellings (`env_file` string/list/object/`./.env`;
  `environment` list/map, bare/null pass-through; `command` must be an exec array)
  and refuses unmodelled forms.
- Loads YAML via `createComposeYamlLoader` (`check-compose-log-caps.mjs`); k8s via
  multi-document load.
- One single-step red case per invariant (I1.1–I1.6, I2.1–I2.6, W derivation),
  each asserting the exact drift list (`toEqual`), with a no-op-mutation guard;
  semantic mutations on `structuredClone`d objects. Paired allow case per deny
  boundary (object-form `env_file`, blank vs valued `DATABASE_URL`, grace above the
  floor, multi-doc file, Secret referenced twice inside the publisher, `Recreate`
  with no `rollingUpdate`).

### C4 — CI reach
- `ci.yml` `changes.app` gains `infra/k8s/**`; `scripts/pre-pr.sh` `app_paths`
  gains `infra/k8s/` and `infra/terraform/` (declared lockstep, R33).
- C3 asserts both filters reach every file under `infra/k8s/` and
  `docker-compose.workers.yml`, with a negative control.

### C5 — Docs, comments, env metadata
- Member list re-derived by `grep -rn -e docker-compose.workers -e "worker:audit-anchor" -e "worker:audit-chain" -e "no compose service" -e "compose files define no" -e "stop audit-outbox-worker" -e "two workers"`:
  `docs/operations/deployment.md` (SC1 paragraph, log-cap paragraph, new compose +
  k8s operator section incl. upgrade order, per-destination keys, IRSA trust/policy
  mirroring `iam.tf`, RBAC, legacy volume states NOLOGIN and published-password
  LOGIN, key archival step, `config` prints secrets), `docs/setup/docker/en.md`,
  `docs/operations/incident-runbook.md`, `docs/operations/audit-anchor-rotation-runbook.md`,
  `docs/operations/alerts.md`, `README.md`/`README.ja.md` (services line, password
  rows), `CLAUDE.md`, `CONTRIBUTING.md` (compose `command:` entrypoint list, already
  stale), `docs/operations/dev-host-migration.md` (stop-writers steps),
  the exact anchor key CLI invocation for compose/k8s (`AWS_REGION` and credentials
  from the anchor variables in the operator's shell, N4-func), `src/__tests__/db-integration/setup.ts` (stop hint),
  `scripts/audit-chain-verify-worker.ts` comment, `docker-compose.workers.yml`
  header, `scripts/env-allowlist.ts` (password descriptions/consumers; three
  `AUDIT_ANCHOR_AWS_*` entries) + regenerated `.env.example`,
  `check-compose-log-caps.mjs` stale count (T12).
- Acceptance: the grep returns only updated statements; `check:env-docs`,
  `check-doc-paths` pass.

### C6 — App env schema
- `envSchema` (app only) preprocesses the input: a key in `APP_WITHHELD_ENV_KEYS`
  whose value is `""` is dropped — into a new object; `process.env` is never mutated. Worker schemas unchanged (N6).
- `APP_WITHHELD_ENV_KEYS` = W ∩ `envObject` keys, pinned by test against the
  derivation module.
- Production destination check: `GH_REPO` suffices for GitHub.
- `auditAnchorPublisherEnvSchema` picks `AWS_REGION` and requires it when
  `AUDIT_ANCHOR_DESTINATION_S3_BUCKET` is set, so `--validate-env-only` (and the
  k8s startup probe) fails at boot instead of every PUT failing (N4-func). The
  smoke map already gives it; red + allow test.
- The publisher schema applies `emptyAsUnset` to its optional pass-through fields
  only (S3 bucket/prefix, GH repo/token, FS path, `AWS_REGION`) — compose renders
  them as `""` via `${…:-}`; its own-URL and keys stay strict (V1). Test: the
  schema + `buildDestinationsFromEnv` accept compose-shaped env for S3-only,
  GitHub-only and FS-only with every other optional name `""`; red: S3 bucket with
  blank region. C7 also feeds the publisher env it rendered to that validator.
- `emptyAsUnset` moved to `env-schema.ts`, retention-gc imports it. Field shapes are
  not wrapped (the preprocess is object-level on `envSchema`), so
  `npm run generate:env-example` yields no diff beyond the new allowlist entries
  (N3-func, acceptance).
- Tests: production app parses with every W key `""` (U2); each `.env`-loading
  worker validator parses with every W key `""` except its own URL (U2); an empty
  worker own-URL with a valued `DATABASE_URL` is still refused outside production
  (N6); a blank production-required URL in the publisher/verify validators is
  refused with the existing required error (U8); non-blank invalid W value still
  rejected by the app; production app with `GH_REPO` and no token passes;
  `from-env` still refuses GitHub without a token.

### C7 — Compose render check (`scripts/checks/check-compose-render.ts`, run by `npx tsx` from `scripts/pre-pr.sh` in static-checks, like `check:env-docs`; V2)
- `docker compose --project-directory <stub> -f <abs files…> config --format json`
  (stub precondition measured: `build.context: .` resolves to the stub; blank
  `environment` overrides `env_file`). Stub `.env` holds a distinct sentinel per W
  key and per required variable; never reads the repo `.env`; prints key names,
  never values.
- Runs under a scrubbed environment (`env -i` with `PATH`, `HOME`, and
  `DOCKER_HOST`/`DOCKER_CONFIG` when set) so shell values and `COMPOSE_*` cannot
  override the stub; `--profile migrate` passed explicitly (N2-func). The N3
  shell-override case sets `DEPLOYMENT_ID` deliberately inside that scrubbed env.
- Renders every documented `-f` set: base+override (dev default), base+workers,
  base+workers+logging, base+ha (U3).
- Asserts per the shared (service,key) table: `.env`-loading services hold `""` for
  every W key except their own URL; (c) sentinels in no value outside the
  publisher; publisher holds its ECS names; verify worker env exact;
  `DEPLOYMENT_ID` equal in publisher and retention-gc with a shell override set
  (N3); removing each `:?` variable fails the render naming it.
- Self-test `scripts/__tests__/check-compose-render.test.ts`: assertion logic on
  canned render JSON (runs everywhere, red + allow cases) plus one real-compose red
  case on a mutated scratch copy plus a real-render allow case on the tree (V3),
  skipped only when docker is absent and `CI` is not `true` (hard-fail in CI) (U7).
  Fixtures record the compose version that produced them; the check prints
  `docker compose version` (V3).
- The check itself: hard-fail without docker when `CI=true`, a visible `SKIPPED`
  line locally (V4). It imports `env-schema.ts` and the hcl-subset helper, which
  moves from `src/__tests__/helpers/` to `scripts/lib/` (re-exported, including
  `TERRAFORM_DIR`, from the old path for its importers; `hcl-subset.test.ts` moves to
  `scripts/__tests__/hcl-subset.test.ts` (inside vitest's include; same test count
  before/after, Y1); `TERRAFORM_DIR`'s
  relative depth becomes `../../infra/terraform` and is defined only in the moved
  module; the old path is an `export * from` shim; a test asserts `TERRAFORM_DIR`
  contains `ecs.tf`) so a static check does not import a test helper (V2, func-Q2, W3).
- Stub sentinels are distinct AND valid for their type: hex64 keys, UUID
  `DEPLOYMENT_ID`, fixed-length (≥24) random `[A-Za-z0-9]` passwords (URL-safe
  inside the interpolated URL); the self-test asserts no sentinel is a substring of
  another (X3);
  the self-test asserts the stub passes the publisher validator (func-Q1).

### C8 — Docker smoke hardening
- `scripts/checks/lib/worker-bundle-smoke.mjs` docker runner adds
  `--read-only --user 1001:1001 --cap-drop ALL` (pod securityContext). Boot only.
- `scripts/__tests__/check-worker-bundle-smoke.test.mjs` argv assertion updated;
  asserts each flag present with a red case per removed flag (U4). Only the
  container-scan run proves the flags work in a real container.

### C9 — Self-test meta-gate reaches `.ts` checks
- `scripts/checks/check-gate-selftest-coverage.sh` member set adds
  `scripts/checks/*.ts` (header comment updated); `check-rls-grant-evidence.ts`
  already has its test, `check-compose-render.ts` gets
  `check-compose-render.test.ts`. The meta-gate's self-test gains a red fixture:
  a `.ts` check with no sibling test reports `MISSING_GATE_SELFTEST` (W1); the
  extension strip (`base_noext`) at both sites handles `.ts`, with an allow fixture:
  a `.ts` check with a sibling `.test.ts` passes (func-R1), and a `.ts` stale-debt
  fixture (debt entry whose test exists) reports `STALE_DEBT_ENTRY` (X1).

## Testing strategy

C3 + C6 vitest; C7 static-check with self-test; existing gates re-run
(`check-compose-log-caps`, `check:env-docs`, bundle smoke). Coverage limits stated
honestly: the bundle smoke boots with the smoke map's env, not the YAML's;
`check-compose-image-pin` examines nothing for `build:`-only services. Full
`npx vitest run` + `npx next build`.

## Considerations & constraints

### Scope contract
- SC1 Cluster apply / kubeconform — E1.
- SC2 Real `up` of the new services — E2.
- SC3 Heartbeat liveness — existing tracked follow-up.

### Risks
- R-a Existing volumes: `passwd_anchor_publisher` NOLOGIN, or LOGIN with the
  formerly published password; `passwd_audit_chain_verifier` NOLOGIN. Upgrade
  section orders: set passwords → rotate/LOGIN → `DEPLOYMENT_ID` → keys →
  archive public key → `up -d`.
- R-b Breaking for compose operators using the workers overlay (`:?` fails the
  whole render). Commit `feat!` (0.x with `bump-minor-pre-major` ⇒ minor bump).

## User operation scenarios

1. Compose upgrade: follows the upgrade section; a missing variable fails
   `config`/`up` naming it; publisher boots, `destinations ready`.
2. Old volume: auth failure loop until the documented role procedure runs.
3. k8s: Secrets/ConfigMap/IRSA role created, image substituted, applied;
   `rollout restart` terminates the old publisher (≤ grace) before the new one starts.
4. A fifth ECS worker: smoke-map test forces the map entry; C3 then fails until
   compose and k8s define it.
5. A new compose service with `env_file: .env`: C3/C7 fail until it blanks W.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | Compose services + blanking | locked |
| C2 | k8s manifests | locked |
| C3 | Parity test | locked |
| C4 | CI reach | locked |
| C5 | Docs/comments/env metadata | locked |
| C6 | App env schema | locked |
| C7 | Compose render step | locked |
| C8 | Docker smoke hardening | locked |
| C9 | Self-test meta-gate reaches .ts checks | locked |

## Implementation Checklist

Batches (sequential A → B → C ∥ D):
- **A (C6 + shared derivation)**: `src/lib/env-schema.ts` (emptyAsUnset export,
  `APP_WITHHELD_ENV_KEYS`, envSchema object preprocess, GH_REPO-only production
  check, publisher pick `AWS_REGION` + S3⇒region refine + emptyAsUnset on
  pass-through fields), `src/lib/env-schema.test.ts`, `scripts/retention-gc-worker.ts`
  (import emptyAsUnset), `scripts/env-allowlist.ts` (three `AUDIT_ANCHOR_AWS_*`
  secret entries; password-entry descriptions/consumers), regenerated
  `.env.example`, `scripts/checks/lib/hcl-subset.ts` (moved; `TERRAFORM_DIR` depth) +
  shim `src/__tests__/helpers/hcl-subset.ts` + `scripts/__tests__/hcl-subset.test.ts`
  (moved test, TERRAFORM_DIR assertion), `scripts/checks/lib/withheld-env.ts` (W derivation,
  holder table, role-user pins) + its tests.
- **B (C1, C2, C3, C4)**: `docker-compose.yml` (app blanks W),
  `docker-compose.override.yml` (worker blanks), `docker-compose.workers.yml`
  (two services, existing workers' blanks, retention-gc DEPLOYMENT_ID),
  `infra/k8s/audit-anchor-publisher.yaml`, `infra/k8s/audit-chain-verify-worker.yaml`,
  `src/__tests__/infra/worker-deploy-parity.test.ts`, `.github/workflows/ci.yml`,
  `scripts/pre-pr.sh` (`app_paths`).
- **C (C7, C8, C9)**: `scripts/checks/check-compose-render.ts` +
  `scripts/__tests__/check-compose-render.test.ts` + fixtures, `scripts/pre-pr.sh`
  queue_step, `scripts/checks/lib/worker-bundle-smoke.mjs` +
  `scripts/__tests__/check-worker-bundle-smoke.test.mjs`,
  `scripts/checks/check-gate-selftest-coverage.sh` +
  `scripts/__tests__/check-gate-selftest-coverage.test.mjs`.
- **D (C5)**: docs listed in C5, `CLAUDE.md`, `CONTRIBUTING.md`,
  `src/__tests__/db-integration/setup.ts`, `scripts/audit-chain-verify-worker.ts`
  comment, `scripts/checks/check-compose-log-caps.mjs` count comment.

Shared utilities to reuse: `createComposeYamlLoader` and compose file discovery
(`scripts/checks/check-compose-log-caps.mjs`), `TerraformConfig`/`HclUnknown`
(hcl-subset), `envObject`/`emptyAsUnset` (env-schema), allowlist entries
(`scripts/env-allowlist.ts`), smoke map (`scripts/checks/worker-bundle-smoke.json`),
fixture harness env vars of `check-gate-selftest-coverage.test.mjs`, `queue_step`
in `scripts/pre-pr.sh`, ci.yml filter parsing in
`scripts/__tests__/check-required-aggregate.test.mjs`, `app_paths` extraction in
`scripts/__tests__/backup-db.test.mjs`.

CI gate parity: the 23 CI-extracted gates are already in pre-pr.sh or run by
`npm run`; the new C7 check is added to pre-pr.sh (static-checks runs it in CI).
