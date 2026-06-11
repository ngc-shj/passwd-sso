# Coding Deviation Log: post-530-hardening

## Phase 2 implementation deviations

- C3 migration: `prisma migrate dev --create-only` initially emitted a schema-diff SQL; replaced with the hand-written REVOKE per the plan (permission change, no schema diff). Applied to the dev DB via `migrate deploy` (mutates the dev DB — intended by the plan). Migration: `20260611011121_revoke_public_connect_on_app_db`.
- C3 verification: the full integration suite still shows 224 passed after the REVOKE (legit roles passwd_app/workers still connect — if REVOKE had broken them we'd see "permission denied for database", not the same pre-existing failures). The 4 failing integration tests (audit-anchor manifest, audit-sentinel backfill, mobile cache-rollback x2) are the same pre-existing shared-dev-DB noise documented in #530 / the concurrency PR — none are connection-refused, none touch this PR's files. The new `revoke-public-connect.integration.test.ts` passes (probe role CONNECT=false, 4 legit roles=true). CI integration job on a fresh DB is the authoritative proof.
- C3 dev DB note: `jackson_user` does not exist on the local dev volume (initdb already ran before #530's role was added), mirroring CI — so the local manual jackson_user-refused check is N/A; the probe-role test is the CI-safe structural guard.

## Follow-up tracked

- SC1 / PR-B: DCR per-IP unclaimed cap (#530 review item 4 = SC7) — schema change, separate triangulate cycle.
- SC2 TODO(post-530-hardening): `check:env-docs` does not regenerate-and-byte-compare `.env.example` (pre-existing tooling gap). C4's T4 test partially mitigates.
