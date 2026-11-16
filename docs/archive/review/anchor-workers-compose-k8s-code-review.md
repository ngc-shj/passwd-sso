# Code Review: anchor-workers-compose-k8s
Date: 2026-11-16
Review round: 1

## Changes from Previous Round
Initial review (incremental on the Phase 2 self-R-check baseline). Ollama
unavailable: no seeds, full-diff review by three fresh experts; deduplicated
manually.

## Functionality Findings
- **func-F1 [Major]** `scripts/env-allowlist.ts` (`AUDIT_ANCHOR_AWS_ACCESS_KEY_ID` /
  `AUDIT_ANCHOR_AWS_SECRET_ACCESS_KEY`), `scripts/init-env.ts` (external-allowlist
  loop): `init:env` offers default-yes random generation for the AWS credential
  names; a random key overrides the documented default-chain fallback and every S3
  call fails while `--validate-env-only` passes.
- **func-F2 [Minor]** `CONTRIBUTING.md`: cites `docker-compose.workers.yml` by line
  numbers that shifted (R29).
- **func-F3 [Minor]** = sec-F6 (merged below).
- **func-F4 [Minor]** `docs/operations/deployment.md`, `infra/k8s/audit-anchor-publisher.yaml`:
  no statement that a destination is mandatory (crash loop otherwise); FS volume
  must be writable by uid 1001; non-optional ConfigMap refs block non-S3 k8s.
- **func-F5 [Minor, pre-existing]** `infra/systemd/README.md`: the production unit
  runs the base file only (no workers); `TimeoutStopSec=90` < publisher grace.

## Security Findings
- **sec-F1 [Major]** `scripts/checks/check-compose-render.ts` (`analyzeRender`),
  parity test I1.4, compose header, deployment.md: the withheld-set gate checks env
  and argv values only; a `.env` / project-root bind mount or a top-level
  `secrets:`/`configs:` file source would deliver W undetected (R49/R42).
- **sec-F2 [Minor]** deployment.md / allowlist / compose comment: the instance-role
  fallback is reachable by every container on the host via IMDS.
- **sec-F3 [Minor]** deployment.md: k8s RBAC guidance names only `get` on Secrets.
- **sec-F4 [Minor]** deployment.md / compose header: the non-withheld secret list
  reads as exhaustive; jackson's `AUTH_SECRET` omitted.
- **sec-F5 [Minor]** `docker-compose.workers.yml`: compose publisher/verifier lack
  `read_only`, `cap_drop`, `no-new-privileges` that k8s applies.
- **sec-F6 [Minor] (= func-F3)** deployment.md / publisher manifest: Secret
  `passwd-sso-deployment` described as shared with app and retention-gc; no shipped
  manifest references it.

## Testing Findings
- **T1 [Minor]** render fixture has no freshness check against a real render (RT1).
- **T2 [Minor]** `RENDER_SETS` hand list has no compose-file completeness guard (R42).
- **T3 [Minor]** smoke `--user 1001:1001` not pinned to k8s `runAsUser`/`runAsGroup` (RT9).
- **T4 [Minor]** several red cases assert a partial drift list (`toContain`/`slice`).
- **T5 [Minor]** parity test re-implements `createComposeYamlLoader` (R1), unlogged.
- **T6 [Minor]** publisher `TASK_ENV` hand copy of the smoke map; no boot-level
  `AWS_REGION` red case.
- **T7 [Minor]** test name/mutation mismatch (parity test, verify-worker case).
- **T8 [Minor]** `placeholderizeRender`/`hydrateRecordedRender` round trip and
  `emptyAsUnset` whitespace untested.

## Adjacent Findings
- **A1 [Minor]** (testing → functionality) `check-compose-render.ts`: unguarded
  `JSON.parse` of compose stdout.

## Quality Warnings
None (all findings carry file/line evidence and a concrete fix).

## Recurring Issue Check
(Per-expert blocks are in the hand-backs of this session; non-N/A rows:)
### Functionality expert
R1 ok · R2 ok · R3 F1 · R10 ok · R14 ok · R16 ok · R17 ok · R18 ok · R22 ok · R29 F2,F3 · R32 ok · R33 ok · R34 F5 · R35 ok · R36 ok · R40 ok · R41 F4 · R42 ok · R43 ok · R44 ok · R45 ok · R47 ok · R48 ok · R49 ok · R50 ok · R52 ok · R55 ok · others N/A
### Security expert
R1 ok · R2 ok · R3 F1 · R10 ok · R14 ok · R16 ok · R17 ok · R18 ok · R22 ok · R29 F6 · R32 ok · R33 ok · R34 ok · R35 ok · R36 ok · R40 ok · R41 F2 · R42 F1 · R43 ok · R44 ok · R45 ok · R47 F1 · R48 F1 · R49 F1,F3,F4 · R50 ok · R52 ok · R55 ok · RS3 ok · RS4 ok · others N/A
### Testing expert
R1 T5 · R2 ok · R3 ok · R10 ok · R16 ok · R17 ok · R18 ok · R19 ok · R25 T8 · R32 ok · R33 ok · R34 ok · R35 ok · R39 ok · R40 ok · R41 ok · R42 T2 · R44 ok · R45 ok · R47 ok · R48 ok · R50 ok · R52 ok · R55 ok · RT1 T1 · RT2 ok · RT3 ok · RT5 ok · RT6 T8 · RT7 T6 · RT8 ok · RT9 T3,T5,T6 · RT10 ok · RT11 ok · others N/A

## Environment Verification Report
- E1 (no cluster): k8s apply / kubeconform — `blocked-deferred`, Phase 1 constraint
  E1, Anti-Deferral recorded in the plan review (T10).
- E2 (shared dev DB): real `up` — `verified-local` in an isolated compose project
  (manual-test.md "Status in this PR"); shared DB untouched.
- E3 (no AWS): S3 destination — `blocked-deferred`; existing MinIO tests unchanged.
- Compose render, parity test, bundle smoke — `verified-local` (commands in the
  deviation log), and run in CI via static-checks / app-test / container-scan.

## Resolution Status
### Round 1
- sec-F1 [Major] file channels — Fixed: `envFileSourceKind()` (withheld-env.ts) used by
  `analyzeRender` and the parity test; bind / named-volume device / secrets / configs
  sources that are the project root, an ancestor, or `.env*` are flagged (dev set exempt);
  unmodelled shapes fail; initdb and fluent-bit mounts allowed. Red-proved per channel.
- func-F1 [Major] init:env generation — Fixed: `generate?: boolean` on allowlist entries,
  honoured in init-env; `generate: false` on both AWS credential entries; init-env test
  (deny for AWS keys, allow for PASSWD_* and JACKSON_API_KEY).
- sec-F5 — Fixed: `read_only`, `cap_drop: [ALL]`, `no-new-privileges` on both compose
  services; parity red case per key per service; isolated boot re-run (manual-test.md).
- func-F4 — Fixed: k8s ConfigMap refs `optional: true`; deployment.md destination step,
  uid-1001 volume note, GitHub-only k8s note.
- sec-F6 / func-F3 — Fixed: manifest comment and deployment.md row reworded.
- sec-F2, sec-F3, sec-F4 — Fixed in deployment.md (and the compose comment /
  allowlist descriptions for F2; `.env.example` regenerated).
- func-F2 — Fixed: CONTRIBUTING.md cites subjects, not line numbers.
- func-F5 — Fixed as documentation: `infra/systemd/README.md` states the unit runs no
  workers and how to add the overlay with `TimeoutStopSec` ≥ 120 s + margin.
  Anti-Deferral check: changing `passwd-sso.service` itself is out of this PR's scope
  (it changes what an existing self-hosted install starts on upgrade, unrequested).
  Worst case: a self-hosted operator runs no anchoring until they read the README note;
  Likelihood: medium for that install type; Cost-to-fix: ~15 min plus an upgrade note,
  which belongs to a decision about the unit's default the user has not made.
- T1–T8, A1 — Fixed as specified (fixture freshness via real re-record, RENDER_SETS
  completeness predicate in the test (the check cannot import the top-level-await
  module under tsx CJS), pod uid pinned to `--user`, full-list assertions, shared YAML
  loader, smoke-map-derived TASK_ENV + boot-level AWS_REGION red case, split test,
  round-trip and whitespace tests, guarded JSON.parse).
- Verification: full `npx vitest run` 1193 files / 25025 tests pass; `npx next build`
  pass; render check, env-docs, bypass-rls, meta-gate, lint, typecheck pass.

### Round 2
Findings: func-N1 [Minor] FS volume ownership step; func-N2 [Minor] systemd
`--abort-on-container-exit`; sec-N1 [Major] file channels still open (configs.content,
absolute/`~` binds, symlinks, build.secrets/ssh/additional_contexts, external entries);
sec-N2 [Minor] compose header wording; sec-N3 [Minor] RBAC verb class; sec-N4 [Minor]
optional `s3-bucket` ref (R43 widening); test-R1 [Major] relative `device` named volume
missed by the render check, adjudicators diverged; test-R2 [Minor] render-set completeness
not reached for nested compose files; test-R3 [Minor] freshness projection omitted
mounts/secrets/configs.

- R42 class "file channel to a container": member-set expanded in round 1 (bind/.env,
  secrets/configs file) and again in round 2 (content, absolute, `~`, symlink, build.*,
  external, relative device). Closed by changing the mechanism to default-deny:
  `FILE_CHANNEL_ALLOWLIST` (infra/postgres/initdb, infra/fluent-bit/fluent-bit.conf,
  infra/fluent-bit/parsers.conf, infra/redis/sentinel.conf) plus plain named volumes and
  tmpfs; every other bind, `driver`/`driver_opts`, referenced secrets/configs, external
  entry and build file key is refused, in both adjudicators through one predicate set in
  `scripts/checks/lib/withheld-env.ts`. Allowlist entries are pinned (exist, realpath has
  no symlink, not `.env*`, mounted by a production file). Red-proven per channel against
  real compose on scratch copies (configs.content, /opt, ~/x, device ., build.secrets,
  external) and the symlink case in the parity test. Wired: render check in static-checks
  (pre-pr `Static: compose-render`, CI=true), parity test in app-test.
- func-N1, func-N2 — Fixed (deployment.md chown step; systemd README `--exit-code-from app`).
- sec-N2, sec-N3 — Fixed (header wording, RBAC as a class).
- sec-N4 — Fixed: `s3-bucket` ref non-optional again, pinned with a red case.
- test-R2 — Fixed: compose-file discovery moved to `scripts/checks/lib/compose-files.mjs`
  (no top-level await); the render check enforces render-set completeness on every run.
- test-R3 — Fixed: projection includes per-service and top-level volumes/secrets/configs.
- Verification: full suite 1193 files / 25045 tests pass; build pass; render, log-caps,
  image-pin, bypass-rls, meta-gate, doc-paths, lint, typecheck pass.

### Round 3
Findings: func-F-R3-1 [Major] systemd README advised `--exit-code-from app`, which implies
`--abort-on-container-exit` (verified with `docker compose up --help`, v5.0.2);
func-F-R3-2 [Minor] FS chown step used the unprefixed volume name; func-F-R3-3 [Minor]
false compose rationale in a comment; sec-R1 [Major] default-deny covered only
volume/secret/config/build-file keys (pid, privileged, devices, cap_add, volumes_from,
build.context/dockerfile_inline, security_opt, ipc, userns_mode passed); sec-R2 [Minor]
explicit `name:` aliased an existing volume; sec-R3 [Minor] allowlist not bound to
service or read-only; test-R1 [Major] allowlist pins not reached by CI for PRs touching
only infra/postgres|fluent-bit|redis; test-R2 [Minor] compose discovery pathspec vs walk
mismatch.

- R42 class "container reach to W / host .env": expanded a third time (service keys
  beyond mounts). Closed by default-deny over the whole service schema:
  `SERVICE_KEY_ALLOWLIST` (exact top-level keys production uses, plus the render-added
  `entrypoint: null`), `BUILD_KEY_ALLOWLIST` (context = project root, dockerfile =
  `Dockerfile`, args), `security_opt` exactly `no-new-privileges:true`; every other key
  refused by name in both adjudicators. Red-proven by 7 predicate mutations (scratch
  vitest alias) and per-key red cases in both gates. Wired: render check in
  static-checks on every PR; parity test in app-test.
- `FILE_CHANNEL_ALLOWLIST` entries now `{path, services, readOnly, reason}`: initdb→db,
  fluent-bit confs→fluent-bit, sentinel.conf→sentinel-1..3 (all read-only; the ha
  entrypoint copies sentinel.conf to /tmp before Sentinel rewrites it).
- Allowlist pins (exists, no symlink, not `.env*`, mounted) moved into the render check
  (`fileChannelAllowlistDrift` over `--root`), so they run on every PR; real-docker red
  cases for a symlink-to-.env and a deleted entry.
- Named volumes: rendered `name` must be `compose-render_<key>`; parity refuses `name:`.
- Compose discovery: one predicate `isComposePath` for git and walk, pinned by a test.
- func-F-R3-1..3 fixed (systemd README: drop the abort flag, do not substitute
  `--exit-code-from`; FS step: create with `up --no-start`, chown the compose-created
  name; comment reworded).
- Render fixture re-recorded (it predated the round-1 hardening keys).
- Verification: full suite 1193 files / 25077 tests pass; build pass; all gates pass.

### Round 4
Findings: sec-Q1 [Major] `logging` contents unjudged (`env`/`env-regex`/`labels`/
`labels-regex` export the publisher's env into log records and the fluentd pipeline);
sec-Q2 [Minor] named volumes not bound to services; func-F-R4-1 [Minor] `labels`
refused although audit-log-forwarding.md tells operators to add it, no extension route;
func-F-R4-2 [Minor] duplicated phrase; test-F1 [Minor] freshness projection partial;
test-F2 [Minor] render behaviour unverified on CI's compose version.

- sec-Q1 — Fixed: `LOGGING_DRIVER_ALLOWLIST` (json-file, fluentd) and
  `LOGGING_OPTION_ALLOWLIST` (max-size, max-file, fluentd-address, fluentd-async,
  fluentd-retry-wait, fluentd-max-retries, tag) in `loggingProblems()`, called from
  `serviceKeyProblems` (both gates); every other driver/option/key refused by name.
  Red per option and for `gelf`; predicate mutations red.
- sec-Q2 — Fixed: `NAMED_VOLUME_ALLOWLIST` (postgres_data→db, redis_data→redis) with a
  pin; deployment.md tells operators to add an FS anchor volume to it with its service.
- func-F-R4-1 — Fixed: `labels` allowed (metadata only; values still scanned for W, with
  a deny test); deployment.md states how to extend `SERVICE_KEY_ALLOWLIST`.
- func-F-R4-2 — Fixed.
- test-F1 — Fixed: full hydrated render compared when the compose version matches the
  fixture's; otherwise the projection with a visible warning naming both versions.
- test-F2 — Mitigated: an unknown render-time key fails the check naming it (stub-docker
  test). CI's compose version is verified on push (recorded below after CI runs).
- Verification: full suite 1193 files / 25091 tests pass; build pass; all gates pass.

### Round 5
Findings: sec-S1 / test-G2 [Major, converged] `logging.options.tag` is a Go template
over the logger info (ContainerEnv, ContainerArgs, ContainerLabels), so an allowlisted
`tag` could write the publisher's signing key into every record; func-F-R5-1 [Minor]
documented awslogs step refused; func-F-R5-2 [Minor] extension route documented for two
of five allowlists; test-G1 [Minor] full-render freshness never runs in CI on a different
compose version. Security's per-key verdicts for every other allowlisted key: covered or
not a W channel.

- sec-S1 / test-G2 — Fixed: any `tag` containing `{{` is refused in both gates (the
  shipped literal `app.passwd-sso` passes); red cases include `{{.ContainerEnv}}`,
  whitespace and `index` spellings, and `{{.Name}}`. Mutation-proved.
- func-F-R5-1 — Fixed: `awslogs` driver and its four options allowlisted; env,
  env-regex, labels, labels-regex stay refused for every driver; forwarding doc notes
  that a committed awslogs block also needs an `OFF_HOST_ALLOW` entry in log-caps.
- func-F-R5-2 — Fixed: one extension-route sentence for all five allowlists in
  deployment.md and a pointer in audit-log-forwarding.md.
- test-G1 — Fixed: under `CI=true` a compose-version mismatch or unknown version fails
  with both versions and the re-record command; locally it warns and compares the
  projection. Stub-docker red/allow cases.
- Verification: full suite 1193 files / 25097 tests pass; build pass; gates pass.
