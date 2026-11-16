# Manual Test Plan: anchor-workers-compose-k8s

Deployment artifacts changed: `docker-compose.yml`, `docker-compose.override.yml`,
`docker-compose.workers.yml`, `infra/k8s/audit-anchor-publisher.yaml`,
`infra/k8s/audit-chain-verify-worker.yaml`. Tier 2: the change governs where
signing keys and DB role credentials reach.

## Pre-conditions
- A disposable Docker host with its own Postgres volume (NOT the shared dev DB).
- `.env` from `npm run init:env -- --profile=production`, plus
  `PASSWD_ANCHOR_PUBLISHER_PASSWORD`, `PASSWD_AUDIT_CHAIN_VERIFIER_PASSWORD`,
  `DEPLOYMENT_ID`, `AUDIT_ANCHOR_SIGNING_KEY`, `AUDIT_ANCHOR_TAG_SECRET`, and a
  destination (e.g. `AUDIT_ANCHOR_DESTINATION_FS_PATH=/anchors` with a named volume
  for a throwaway run, or an S3 bucket + `AUDIT_ANCHOR_AWS_*`).
- Built image: `docker compose -f docker-compose.yml -f docker-compose.workers.yml build`.

## Steps and expected results
1. `docker compose -f docker-compose.yml -f docker-compose.workers.yml up -d`
   → all services up; `docker compose … logs audit-anchor-publisher` shows
   `destinations ready`; the verify worker logs `starting`.
2. Isolation: `docker compose … exec app sh -c 'printf %s "$AUDIT_ANCHOR_SIGNING_KEY" | wc -c'`
   → `0`. Same for `PASSWD_SUPERUSER_PASSWORD`, `MIGRATION_DATABASE_URL`, `GITHUB_TOKEN`
   in `app`, `audit-outbox-worker`, `retention-gc-worker`.
3. Publisher holds its key: same command in `audit-anchor-publisher` → `64`.
4. Missing variable: unset `PASSWD_ANCHOR_PUBLISHER_PASSWORD` in `.env`;
   `docker compose … config --quiet` fails naming it.
5. Stop-before-start: `docker compose … up -d --force-recreate audit-anchor-publisher`
   while watching `docker ps` → the old container exits before the new one starts;
   `docker inspect -f '{{.Config.StopTimeout}}'` → `120`.
6. Existing volume with NOLOGIN roles: publisher logs auth failures until the
   `ALTER ROLE … LOGIN` procedure in `docs/operations/deployment.md` is applied.
7. k8s (cluster required): substitute the image, create the Secrets/ConfigMap/IRSA
   role per `docs/operations/deployment.md`, apply both manifests; publisher pod
   `Ready`; `kubectl rollout restart deploy/audit-anchor-publisher` terminates the
   old pod before the new pod is created (`Recreate`).

## Adversarial scenarios
- A new compose service added with `env_file: .env` and no blanks →
  `npx tsx scripts/checks/check-compose-render.ts` and the parity test fail
  naming the service and keys.
- A worker URL rewritten to `passwd_user:${PASSWD_SUPERUSER_PASSWORD:?…}` → the
  render check flags the superuser sentinel outside `migrate`/`db`.
- `GITHUB_TOKEN` added to the publisher → parity test fails (I1.3 exact set).

## Rollback
`docker compose -f docker-compose.yml -f docker-compose.workers.yml stop
audit-anchor-publisher audit-chain-verify-worker` and redeploy the previous
release's compose files. k8s: `kubectl delete -f infra/k8s/audit-anchor-publisher.yaml
-f infra/k8s/audit-chain-verify-worker.yaml`. No schema change to revert.

## Status in this PR
Run on 2026-11-16 (dev host, Docker Compose v5.0.2) in an isolated compose project
(`-p anchor946smoke`, its own Postgres volume, no published ports, a stub env file
with random throwaway values; the repo `.env` and the shared dev database were not
used), with the image built from this branch:
- Step 1: `db` healthy, `migrate` exited 0 on the fresh volume; the publisher
  logged `destinations ready` then `audit-anchor-publisher.cadence_healthy`
  (it connected as `passwd_anchor_publisher` and read the chain); the verify
  worker logged `starting (tick=3600000ms)` and an
  `audit-chain-verify-heartbeat` with `tenantCount` 1, `verifiedTenantCount` 1,
  `erroredTenantCount` 0 (the read-only role works end to end).
- Steps 2–3 (publisher/verifier containers): uid 1001; signing key length 64 in
  the publisher, 0 in the verifier; `DATABASE_URL` empty in both. The `app` and
  `.env`-loading workers were not started; their blanks are covered by
  `check-compose-render.ts` on the rendered config.
- Step 5: `StopTimeout` 120; `up -d --force-recreate audit-anchor-publisher`
  recreated the single container (old stopped before the new one started).
- Not run: step 4 as a real `up` (covered by the render check's `:?` cases),
  step 6 (no legacy volume), step 7 (no cluster — E1).

