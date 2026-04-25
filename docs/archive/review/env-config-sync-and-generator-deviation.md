# Coding Deviation Log: env-config-sync-and-generator

## D1 — Schema extracted into `src/lib/env-schema.ts` (new file, not in plan)

- **Plan stated**: Plan §B and Step 3 describe `src/lib/env.ts` exporting both `envObject` and `envSchema`. The `Record<keyof z.infer<typeof envObject>, ...>` sidecar typing was specified to import from `@/lib/env`.
- **What shipped**: A new `src/lib/env-schema.ts` holds the side-effect-free schema definitions (`envObject`, `envSchema`, `getSchemaShape`, `Env`). `src/lib/env.ts` is now a thin wrapper that imports from env-schema and adds only the module-load `parseEnv()` side effect that Next.js instrumentation relies on.
- **Why**: The worker (`scripts/audit-outbox-worker.ts`) needs `envObject.pick({...})` access without triggering the full refined `parseEnv()` at import time. With everything in `env.ts`, any import would run the full validation — breaking worker boot in production when non-worker vars (auth providers, WebAuthn) are not set in the worker container. The split isolates the side effect to the `env.ts` module that Next.js boots via dynamic `import()`.
- **Impact on plan invariants**: Zero. `envObject` and `envSchema` are both re-exported from `src/lib/env.ts` so every plan-specified import path still works. Sidecar uses `keyof z.infer<typeof envObject>` from `@/lib/env-schema` — matches the plan's intent (keyof resolves to the pickable ZodObject's keys).

## D2 — `readByApp: boolean` flag added to `LiteralAllowlistEntry`

- **Plan stated**: The allowlist type in plan SEC-3 specified `{ justification; consumers; reviewedAt }`. Check 9 was "no allowlist key appears as process.env.X in src/**/*.ts". The plan did not discuss framework-set vars.
- **What shipped**: `LiteralAllowlistEntry.readByApp?: boolean`. Check 9 exempts entries with `readByApp: true`. `NEXT_RUNTIME` (set by Next.js at runtime, read by `src/instrumentation.ts:8`) has this flag.
- **Why**: Without the flag, check 9 flags NEXT_RUNTIME as a rule violation (it IS read by src/**) but moving it to Zod is wrong — it's framework-set, not user-configurable. The flag expresses the legitimate exception while keeping the general rule strict for user-configurable keys.
- **Blast radius**: Narrow. Only one entry currently uses the flag. The drift checker requires the flag to be explicitly set — it does not default to true. Governance: `scripts/env-allowlist.ts` is CODEOWNERS-gated and in `check-codeowners-drift.mjs` ROSTER_GLOBS.

## D3 — `scripts/lib/compose-env-scan.ts` scope tightened to host-env references only

- **Plan stated**: Plan §D check 3 "every var referenced in any `docker-compose*.yml`". The limited-subset parser was specified as handling list/map forms with `${VAR}` substitution.
- **What shipped**: The scanner extracts ONLY host-env references — `${VAR}` substitution + bare `- VAR` list-form pass-through. Container-internal literal assignments (`POSTGRES_DB: passwd_sso`, `DB_ENGINE: sql`) are NOT flagged as drift.
- **Why**: `docker-compose.yml` has ~20 literal assignments that are container-internal configuration (Jackson container's `DB_ENGINE: sql`, Postgres container's `POSTGRES_USER: passwd_user`, etc.). These never reference host env. The plan's phrasing "every var referenced" was ambiguous; the implementation interprets it as "every var pulled from host env", which matches the intent (drift detection cares about whether the host env surface is covered by Zod or allowlist).
- **Alternative rejected**: Adding all ~20 literal vars to the allowlist would bloat the allowlist with non-security-relevant noise.

## D4 — Plan file `docs/archive/review/env-config-sync-and-generator-plan.md` edited during Phase 2 Step 2-1

- **Plan stated**: The plan is frozen after Phase 1.
- **What shipped**: A new "## Implementation Checklist" section was appended to the plan file during Phase 2 Step 2-1 impact analysis, per the triangulate skill's Step 2-1 obligation.
- **Why**: Phase 2 Step 2-1 explicitly instructs the orchestrator to append an Implementation Checklist to the plan. This is a skill-prescribed append, not a post-freeze plan edit.
- **Impact**: None — the section is additive; no earlier content was modified.

## D5 — SMTP_PORT empty-string boot behavior tightened

- **Plan stated**: NF-5 F22 documented this as an intentional tightening ("empty-string SMTP_PORT now rejects at boot instead of producing NaN at connect time").
- **What shipped**: As documented. `z.coerce.number().int().min(1).max(65535).default(587)` rejects empty string at Zod parse.
- **Why**: Matches plan. Recording here for audit traceability only.

## D6 — `docs/archive/review/*-plan.md` included in `feature` branch's first commit

- **Plan stated**: Plan file is committed on the branch first, then feature commits follow.
- **What shipped**: Correct — plan + review committed in `d18e47aa`, then seven feature commits.
- **Impact**: None.

## D7 — `src/lib/key-provider/env-provider.ts:61` bracket V-access NOT refactored to schema-typed lookup

- **Plan stated**: A-Table-1 row D6-split: *"`env-provider.ts:61` is refactored to use `envObject.shape` lookup for V1..V10, bracket fallback for V11..V100."*
- **What shipped**: `env-provider.ts` is unchanged. V1 still uses `process.env.SHARE_MASTER_KEY_V1` literal access; V2..V100 all use `process.env[\`SHARE_MASTER_KEY_V${version}\`]` bracket access.
- **Why the plan's refactor was not applied**:
  1. Using schema-typed values requires importing the validated `env` singleton from `@/lib/env`. That import triggers `parseEnv()` against the FULL refined schema. env-provider.ts is called transitively from `src/instrumentation.ts:14-16` — the call chain already passes through `@/lib/env`, so the import is cache-hit-safe at Next.js boot, but not at the worker process boundary (the worker uses `envObject.pick({...})` via env-schema precisely to avoid full parseEnv).
  2. The env.ts header explicitly declares: *"Phase 1: Validation only. Existing process.env references are unchanged. Phase 2 (future): Migrate consumers to import { env } from @/lib/env."* The env-provider refactor is the canonical Phase 2 migration task.
  3. Applying the refactor in this PR would start the Phase 2 migration in a non-rollback-friendly place (the getter for master keys is on the hot path for every decrypt operation). A mistake here has a large blast radius.
- **What this does NOT break in practice**:
  - Runtime behavior is unchanged (V1..V10 are in the schema and still available via `process.env` after load-env.ts populates them).
  - The drift-checker's check 9 (`scanAppEnvReaders`) matches `process.env.X` dot-form only; bracket-computed `process.env[...]` reads are invisible to it, so neither the V1..V10 Zod declarations nor the V11..V100 regex allowlist entry generates a false positive.
- **Follow-up plan**: The Phase 2 migration of `env-provider.ts` is tracked as `TODO(env-config-phase2): migrate V1..V10 to env.SHARE_MASTER_KEY_V{N} typed access; V11..V100 fall through bracket fallback with an explicit `// allowlisted-regex` comment`. A grep-visible marker can be added in a follow-up PR.
- **Verification**: `grep -rn "process.env.SHARE_MASTER_KEY_V" src/lib/key-provider/env-provider.ts` confirms the reads remain literal (V1) + bracket-computed (V2..V100).
