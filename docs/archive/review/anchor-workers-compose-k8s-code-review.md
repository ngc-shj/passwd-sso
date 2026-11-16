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
