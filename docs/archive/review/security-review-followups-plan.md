# Plan: security-review-followups

Branch: `fix/security-review-followups` (off main @ `baa24794`, PR #651 merged)

One follow-up PR closing ALL remaining findings from the 2026-07 adversarial
security review of PR #651 (reviewer priorities P1–P5 / finding ids F1, F2, F5,
F6, F7, F8, plus operator-docs item P5). F3/F4 were accepted inside #651 and
are NOT in scope.

## Project context

- Type: web app (Next.js 16 App Router) + CLI (ESM package) + browser extension + iOS, monorepo
- Test infrastructure: unit (vitest, root + cli + extension) + real-DB integration + E2E + CI/CD (static-checks job runs WITHOUT `prisma generate`)
- Verification environment constraints:
  - VE1: E2E stack (docker compose + browsers) may be down; all contracts here are unit/guard-testable — no contract depends on E2E. All paths `verifiable-local`.
  - VE2: static-checks CI job runs shell/mjs guards with no generated Prisma client; any new/changed guard must not import `@prisma/client` (pure text/filesystem scan, model: `check-permanent-delete-stepup.sh`).
  - VE3: HIBP upstream (`api.pwnedpasswords.com`) is not called in tests — the route test mocks `fetch`. Cache eviction is `verifiable-local`.

## Objective

Close the six code findings + one docs finding in one PR, each with
mutation-capable tests/guards, without behavior regressions to the flows fixed
in PR #651 (CSV export→import round-trip fidelity, MCP replay revocation,
step-up guard green on current tree).

## Requirements

Functional:
1. (F6/P1) HIBP proxy cache never does a full `cache.clear()` at cap; bounded FIFO eviction instead.
2. (F1/P2) The `@browser-redirect` step-up exemption is guard-verified against the *actual recovery implementation and its regression test*, not just sentinel presence in the allowlist.
3. (F2) A machine-readable manifest binds every gated step-up server id to its route path tokens, with a completeness check and a best-effort detector for unmarked NEW client call sites of already-covered ids.
4. (F5/P3) CSV formula-injection trigger also neutralizes leading-whitespace variants (`"  =HYPERLINK(...)"`), symmetrically on export (app + CLI) and import strip, keeping export→import round-trip lossless.
5. (F7/P4) Worker / retention / audit-chain execution contexts get a policy manifest with mechanically-verified fields, mirroring `route-policy-manifest.json` governance.
6. (F8) MCP refresh-replay audit metadata records the *stored* (token-row-derived) clientId as authoritative, retaining the presented value separately.
7. (P5) Operator docs state explicitly that the Tailscale Edge path is an "any Tailscale peer (CGNAT range)" boundary, not per-tenant tailnet isolation, and that strict isolation requires per-tenant `allowedCidrs`.

Non-functional:
- No new runtime dependencies. Guards keep bash-3.2 compatibility and VE2 (no Prisma import).
- All existing tests stay green; `pre-pr.sh` passes.

## Technical approach

No concurrency/isolation-level primitives are introduced (no plan-stage DB
probe required). All changes are: one in-memory eviction loop, shell-guard
extensions + fixtures, one regex widening propagated to a byte-identical CLI
twin, one JSON manifest + vitest enforcement test, one additive result-shape
field + audit metadata change, and docs prose.

### Contracts

#### C1 — HIBP cache bounded FIFO eviction (F6/P1)

- File: `src/app/api/watchtower/hibp/route.ts` (no exported-signature change; module-private eviction logic).
- Replace the at-cap block (current lines 80–88):
  1. delete expired entries (keep);
  2. then `while (cache.size >= MAX_CACHE_ENTRIES)` delete `cache.keys().next().value` (Map insertion order ⇒ FIFO); never `cache.clear()`.
- Invariants (app-enforced — a Map has no schema layer):
  - I1: `cache.size <= MAX_CACHE_ENTRIES` after every insert.
  - I2: an insert at cap evicts oldest-inserted entries only; most-recently-inserted non-expired entries survive.
- Forbidden patterns:
  - pattern: `cache.clear()` in `src/app/api/watchtower/hibp/route.ts` — reason: the wholesale-reset class this contract removes (same class as the rate-limit memory-fallback fix in #651).
- Acceptance criteria:
  - AC1: route test — fill the cache to the real `MAX_CACHE_ENTRIES` (5,000) by looping mocked requests (auth/rate-limit/fetch all mocked; no production test seam is added — the constant stays module-private), then insert one more entry E to trigger eviction. Assert: (a) the OLDEST filled prefix now misses (refetches upstream), AND (b) a prefix filled just BEFORE E (e.g. the 5,000th of the fill loop — a pre-capping-insert entry, NOT E itself) still hits with zero upstream `fetch` calls (RT8 negative assertion). Rationale (review T1): eviction runs before `cache.set`, so E itself survives under BOTH FIFO and `cache.clear()` — only a pre-existing entry's survival discriminates the two. If the 5k loop proves too slow in practice (>~5 s), the fallback seam is an env-var override read once at module load — decision recorded in the deviation log.
  - AC2: mutation-capable — reverting the eviction block to `cache.clear()` makes AC1's assertion (b) fail (the pre-capping entry is wiped). Prove once locally by temporary mutation; record in the review log.
  - AC3: module-state isolation (review T2) — each new cap test opens with `vi.resetModules()` + `const { GET } = await import("./route")` to get a fresh module-scoped `cache` (idiom precedent: `src/__tests__/env.test.ts`, `src/lib/redis.test.ts`), so the fill-to-cap state neither pollutes nor depends on the 10 existing tests' reserved prefixes. AC1's (a)+(b) run sequentially within ONE `it()` against the same filled cache. Implementation note (round-2 advisory): the file will mix the existing static top-level `import { GET }` (10 existing tests, unchanged) with the new test's post-`resetModules` dynamic import — the two resolve to independent module-registry entries with separate `cache` state, which is exactly the isolation wanted; hoisted `vi.mock` declarations re-apply to the re-imported instance (empirically validated via `src/lib/redis.test.ts`).
- Consumer-flow walkthrough: response body/shape unchanged; sole consumer `use-watchtower` hook reads the text body — no field change, walkthrough N/A (no shape contract).

#### C2 — `@browser-redirect` exemption hardening (F1/P2)

- Files: `scripts/checks/check-step-up-client-coverage.sh`, `scripts/checks/stepup-client-exempt.txt`, the 3 exempt route files + their sibling `route.test.ts`, `scripts/__tests__/check-step-up-client-coverage.test.mjs`.
- Member-set (R42, code-derived): `grep -n '@browser-redirect' scripts/checks/stepup-client-exempt.txt` → `mcp-authorize-get` (`src/app/api/mcp/authorize/route.ts`), `mcp-authorize-consent-post` (`src/app/api/mcp/authorize/consent/route.ts`), `mobile-authorize-get` (`src/app/api/mobile/authorize/route.ts`). The guard change is generic over ANY current or future `@browser-redirect` entry — the set is re-derived by the guard at run time, not frozen to these 3. (Phase 2 confirms exact route file paths via the guard's own server-id→file mapping.)
- Design:
  1. During the server-marker scan, record an `id → route-file` map (the guard already visits each gated call line; retain the file path).
  2. For each exempt entry whose marker is `@browser-redirect`:
     - `BROWSER_REDIRECT_RECOVERY_MISSING`: the id's route file must contain the literal marker `@browser-redirect-recovery` (placed as a comment on the 403→redirect conversion in the handler).
     - `BROWSER_REDIRECT_TEST_MISSING`: the sibling `route.test.ts` (same directory as the route file) must exist and contain the literal marker `@browser-redirect-recovery-test` (placed as a comment on the regression test asserting the redirect status/Location).
  3. Add both markers to the 3 route files / test files at the exact code/test locations that implement/pin the redirect recovery.
- Invariants (app-enforced via CI guard):
  - I1: an `@browser-redirect` exemption cannot pass the guard unless both the recovery code marker and the redirect regression-test marker exist.
  - I2: deleting the redirect conversion code or its regression test (which removes the marker with it) turns the guard red.
- Forbidden patterns:
  - pattern: `@browser-redirect-recovery` appearing in a route file with no `redirect` token (case-insensitive) within ±5 lines — reason: marker must anchor the actual conversion, not float at file top. (Guard-enforced proximity check. Helper-abstracted conversions still satisfy it: the marker sits on the call line and every recovery helper spelling contains `redirect` — `NextResponse.redirect`, `redirectToSignIn`; if a future helper drops the token, the guard fails loudly toward marker relocation, the safe direction.)
- Acceptance criteria:
  - AC1: guard passes on current tree after markers are added.
  - AC2: self-test fixtures — new fixture cases prove `BROWSER_REDIRECT_RECOVERY_MISSING` and `BROWSER_REDIRECT_TEST_MISSING` each fire (mutation-capable per RT7).
  - AC3: a non-`@browser-redirect` exempt entry's behavior is unchanged (existing fixtures stay green).
- Consumer-flow walkthrough: N/A (no runtime shape; the guard consumes the exempt file + route tree — both sides changed together here and pinned by fixtures).

#### C3 — Step-up id ↔ path-token manifest + new-call-site detector (F2)

- Files: new `scripts/checks/stepup-route-paths.json`, `scripts/checks/check-step-up-client-coverage.sh` (new checks 5+6), `scripts/__tests__/check-step-up-client-coverage.test.mjs` (fixtures).
- Manifest shape (per gated server id):
  ```json
  { "<id>": { "method": "PATCH", "pathTokens": ["API_PATH.TENANT_POLICY", "/api/tenant/policy"] } }
  ```
  `pathTokens` are fixed strings (API_PATH/apiPath constant spellings and/or distinctive literal path fragments; for dynamic routes the distinctive static segment, e.g. `` }/policy ``).
- Member-set (R42): the id class is derived by the guard itself (server `@stepup id:` markers across `src/app/api` — the defining primitive is `STEPUP_PRIMITIVE_RE`); the manifest must biject with that set. This is mechanically complete by construction — check 5.
- Checks:
  5. `MANIFEST_ID_MISSING` / `MANIFEST_ID_STALE`: server-id set and manifest key set must be equal (both directions).
  6. `UNMARKED_CALLSITE_CANDIDATE` (best-effort detector): for each client file (non-test, outside `src/app/api`) where a `pathToken` of id X appears within the argument window of a `fetchApi(` call AND a mutating method literal matching the manifest `method` appears within the options window (~10 lines), require a `@stepup id:X` client marker in that file. Escape hatch for confirmed false positives: suppression comment `// @stepup-path-ok id:X` on the call line (reason required at ≥10 chars, same discipline as the exempt file).
- Invariants:
  - I1 (app-enforced/guard): every gated id declares its path binding; a new gated route cannot merge without a manifest entry.
  - I2 (guard, best-effort — documented residual): a NEW client file calling a covered id's path with the gated method and no marker fails CI. Residual (SC1): raw template-literal paths whose static fragments are too generic, prop-indirection call sites, and non-`fetchApi` transports remain undetectable — documented in the guard header, unchanged from today's baseline (detector only ADDS detection). `fetchApi` is the project-wide client transport convention (263 non-test call sites: `grep -rn "fetchApi(" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.' | wc -l`; raw `fetch` to API paths in client components is already outside the base guard's model), so keying the detector on `fetchApi(` matches the codebase.
- Forbidden patterns:
  - pattern: `"pathTokens": []` in `stepup-route-paths.json` — reason: an empty binding vacuously satisfies completeness while detecting nothing.
- Acceptance criteria:
  - AC1: manifest covers all current server ids (guard-verified); guard green on current tree — all current call sites are already marked (45-member class wired in PR #644), so the detector must produce zero findings; any hit is either a real pre-existing gap (fix it) or a detector false positive (fix the detector or suppress with reason — decision recorded in the deviation log per case).
  - AC2: fixtures — `MANIFEST_ID_MISSING`, `MANIFEST_ID_STALE`, and `UNMARKED_CALLSITE_CANDIDATE` each proven able to fire (RT7).
- Consumer-flow walkthrough: manifest consumer is the guard (check 5/6 read `id`, `method`, `pathTokens` — all present in the locked shape). No runtime consumer.

#### C4 — CSV leading-whitespace formula trigger (F5/P3)

- Files: `src/lib/format/csv-escape.ts`, `cli/src/lib/csv-escape.ts` (byte-identical twin — MUST change together; parity pinned by `cli/src/__tests__/unit/csv-escape.test.ts`), tests: `src/lib/format/csv-escape.test.ts`, `cli/src/__tests__/unit/csv-escape.test.ts`, round-trip in the import-parser test tree.
- Change: `CSV_FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/` → `/^\s*[=+\-@\t\r]/` in BOTH files (identical spelling).
- Member-set (R42, code-derived): `grep -rln 'CSV_FORMULA_TRIGGER_RE' --include='*.ts'` → definition sites: `src/lib/format/csv-escape.ts`, `cli/src/lib/csv-escape.ts` (duplicate by ESM-package necessity, drift-pinned). Import-side consumers inherit via shared import: `src/lib/audit/audit-csv.ts` (`escapeCsvValue`), `src/components/passwords/import/password-import-parsers.ts` (`stripCsvFormulaGuard`). Extension/iOS: no CSV formula guard exists (grep verified — no member).
- Symmetry analysis (why import strip auto-extends): `stripCsvFormulaGuard` tests `CSV_FORMULA_TRIGGER_RE.test(value.slice(1))` after the `'` prefix — with the widened regex, an exported `'  =x` strips back to `  =x`. Round-trip stays lossless *by SSoT*, but MUST be pinned by a new round-trip test (leading-space payload), because the symmetry is a distributed contract across export/import call sites (cf. `feedback_effective_default_distributed_contract`).
- Compatibility tradeoff (explicit): a legit value with leading whitespace + trigger char (e.g. `  -foo`) is now quote-wrapped + `'`-prefixed on export and stripped on import → round-trip lossless. A value the user *genuinely typed* as `'  =x` loses its leading quote on import — same accepted-cost class as the existing `'=x` case documented in the strip function's comment (extend that comment).
- Invariants:
  - I1 (app-enforced + parity-test-enforced): both regex definitions remain byte-identical.
  - I2: export→import round-trip is lossless for values matching the widened trigger.
- Forbidden patterns:
  - pattern: `/^[=+\-@\t\r]/` (the old, unwidened regex) anywhere in `src/` or `cli/src/` — reason: a stale copy reopens the leading-space variant on one surface.
- Acceptance criteria:
  - AC1: `escapeCsvCompat("  =HYPERLINK(...)")` produces a quoted, `'`-prefixed cell (app + CLI tests).
  - AC2: round-trip test: export a value `  =2+5` via `escapeCsvCompat`, embed the escaped cell in a full synthetic CSV row, and parse it back through the REAL import entry point — `parseCsv`/`parseCsvLine` (which applies `stripCsvFormulaGuard` internally at `password-import-parsers.ts:169`) — NOT a direct call to the private strip function (review T3; R40: actual producer output through actual consumer path). Assert byte equality with the original. Include a leading-`\n` + trigger case (e.g. `"\n=cmd"`) alongside the leading-space case (review S3: the widened `\s*` newly matches it; already quote-wrapped via `includes("\n")`, only the `'`-prefix decision changes — pin the round-trip). Extend the existing round-trip scaffold at `password-import-parsers.test.ts:204`.
  - AC3: `escapeCsvValue` (audit CSV) neutralizes `  =x` (leading-space case) — RS6 ordering preserved (quote-doubling before prefix decision).
  - AC4: negative — `a =b` (interior, not leading) stays unprefixed.
- Consumer-flow walkthrough:
  - Consumer `escapeCsvCompat` callers (`src/lib/format/export-format-common.ts`, `cli/src/commands/export.ts`) read the escaped string and join into CSV — no field change.
  - Consumer `stripCsvFormulaGuard` (import parser) reads the raw cell and the shared regex — regex widening is the entire change; behavior verified by AC2.

#### C5 — Worker / retention / audit-chain policy manifest (F7/P4)

- Files: new `scripts/checks/worker-policy-manifest.json`, new test `src/__tests__/workers/worker-policy-manifest.test.ts`. No worker behavior change.
- Member-set (R42, code-derived; defining primitive = "non-request execution context that opens a DB connection or drives one". Round-1 S1 showed anchoring on `src/workers/` alone misses inline-logic scripts; round-2 S4 showed the glob-union fix was still instance-level (R42 clause ①b: one expansion ⇒ re-derive from the primitive). Final derivation is PRIMITIVE-ANCHORED):
  - Candidate set = `find src/workers -name '*.ts' ! -name '*.test.ts'` UNION `grep -lE 'new PrismaClient\(|new Pool\(|from "@/lib/prisma"' scripts/*.ts prisma/seed.ts` — the grep keys on the DB-connection-opening primitive itself, not filename conventions, so any future script that opens a connection (directly or via the app singleton) surfaces automatically. Verified on the current tree: the script-side grep returns EXACTLY `scripts/audit-chain-verify-worker.ts`, `scripts/migrate-webhook-secrets-v1-to-v2.ts`, `scripts/migrate-account-tokens-to-encrypted.ts`, `prisma/seed.ts` — zero false positives (`env-descriptions.ts`/`check-env-docs.ts` mention env-var names in prose only and do not match; `generate-security-matrices.ts` imports a workers registry for docs generation but opens no connection and does not match).
  - Thin launcher scripts (`scripts/audit-outbox-worker.ts`, `scripts/retention-gc-worker.ts`, `scripts/audit-anchor-publisher.ts`) import `createWorker` from `@/workers/*` and open no connection themselves — they are NOT candidates; they appear as manifest `entrypoint` doc fields whose file-existence the test verifies.
  - The completeness test asserts: every candidate is either claimed by exactly one manifest entry's `modules` OR listed in the manifest's `$documented-exclusions` with a ≥10-char reason — fail-closed governance for future scripts. Both directions (stale manifest keys/`modules`/`entrypoint` paths referencing non-existent files also fail).
  - `$documented-exclusions` (with reasons): `src/workers/worker-pool-config.ts` (constants-only, no DB access); `scripts/migrate-webhook-secrets-v1-to-v2.ts` and `scripts/migrate-account-tokens-to-encrypted.ts` (one-shot operator-invoked `--dry-run`-capable migrations: no unattended steady-state, no retry/poison-message surface for the manifest fields to describe; reviewed per-PR at the diff level — review S4 disposition (b)); `prisma/seed.ts` (permanent no-op seed, no data written).
  - `scripts/audit-chain-verify-worker.ts` has NO `src/workers/*` module counterpart — all its DB logic (incl. `$queryRawUnsafe`) is inlined in the script. Its manifest entry therefore points `modules` at the script file itself, with a manifest comment documenting the exception.
  - Confirmed non-members: `scripts/purge-*.sh` / `rotate-master-key.sh` (curl against HTTP routes — route-manifest territory).
  - security-definer surface: `grep -rl 'SECURITY DEFINER' prisma/migrations` → `20260522000200_audit_log_revoke_via_definer`, `20260618000000_add_retention_gc_worker_role`
  - Documented exclusions (mirror `route-policy-manifest.json` `$documented-exclusions`): maintenance HTTP routes (`purge-failed`, `audit-outbox-metrics`, purge scripts' endpoints) are governed by the ROUTE manifest; `worker-pool-config.ts` is a constants-only module (two exported pool-timeout constants, no DB access — verified) and goes in `$documented-exclusions`, not the entry set.
- Manifest entry shape (keyed by process, with `modules` list):
  ```json
  {
    "audit-outbox-worker": {
      "entrypoint": "scripts/audit-outbox-worker.ts",
      "modules": ["src/workers/audit-outbox-worker.ts", "src/workers/audit-delivery.ts"],
      "dbRole": "passwd_outbox_worker",
      "tenantScoped": true,
      "usesSecurityDefiner": false,
      "rawSql": true,
      "destructive": false,
      "emitsAudit": true,
      "idempotent": "<prose ≥10 chars: mechanism>",
      "retryPolicy": "<prose: backoff/poison handling>",
      "poisonMessageHandling": "<prose>",
      "retentionPolicyTouched": []
    },
    "audit-chain-verify-worker": {
      "entrypoint": "scripts/audit-chain-verify-worker.ts",
      "modules": ["scripts/audit-chain-verify-worker.ts"],
      "$modules-note": "DB logic is inlined in the script (no src/workers counterpart) — mechanical greps run against the script file itself (review S1)."
    }
  }
  ```
  (Illustrative — the real file carries all four process entries with full fields.)
- Verified vs doc fields (same split as route manifest `$schema-note`):
  - Mechanically verified by the vitest test: completeness (module file-set ⇔ manifest, both directions, from the R42 glob above), `rawSql` (`$queryRaw|$executeRaw` grep per module), `destructive` (`deleteMany|DELETE FROM` grep), `emitsAudit` (`logAudit|enqueueAudit|AUDIT_ACTION` grep), `usesSecurityDefiner` (grep of the definer function names extracted from the two migrations), file existence of `entrypoint`/`modules`.
  - Doc fields (review-enforced, presence + ≥10-char prose verified): `tenantScoped` reason, `idempotent`, `retryPolicy`, `poisonMessageHandling`, `retentionPolicyTouched`.
- Invariants:
  - I1 (app-enforced via vitest, runs in normal CI test job — NOT the static-checks job, so Prisma-adjacent imports are allowed but unnecessary; keep it filesystem-only anyway for speed): adding a new worker module without a manifest entry fails the completeness assertion.
- Forbidden patterns:
  - pattern: `"idempotent": true` (bare boolean) — reason: doc fields carry prose, not unverifiable booleans; a bare `true` is false assurance.
- Acceptance criteria:
  - AC1: test green on current tree with all workers enumerated.
  - AC2 (RT7): mutation — test asserts live-tree-derived set equality, so the fixture-free mutations are: "remove one manifest key" (red); "flip `rawSql` to false for a raw-SQL module" (red); "drop a throwaway `scripts/tmp-mutation-check.ts` containing `new PrismaClient(` with no manifest/exclusion entry" (red — the S4 direction, provable via live-tree re-derivation, then delete the file); "shrink an exclusion reason below 10 chars" (red). Prove each once locally and record in the review log.
- Consumer-flow walkthrough: manifest consumers are (a) the vitest test (reads all fields listed — all present), (b) human reviewers/auditors (doc fields). No runtime consumer.

#### C6 — MCP refresh-replay audit uses stored clientId (F8)

- Files: `src/lib/mcp/oauth-server.ts`, `src/app/api/mcp/token/route.ts`, tests `src/lib/mcp/oauth-server.test.ts`, `src/app/api/mcp/token/route.test.ts`.
- Signature change (additive): `exchangeRefreshToken` error-return shape gains `storedClientId?: string`. Phase-1 `replay` and `race_lost` markers add `storedClientId: rt.mcpClient.clientId` (the row's own McpClient public id `mcpc_…`, available at both branches — `findUnique` selects `mcpClient: true`; the replay branch at oauth-server.ts:486 returns before client validation, so this is the only authoritative source). `revoked`/`expired`/`not_found` outcomes are unchanged (no audit emission today — SC5).
- Route audit metadata for `MCP_REFRESH_TOKEN_REPLAY` and the concurrent-rotation audit:
  ```ts
  metadata: {
    clientId: result.storedClientId ?? clientIdValue, // authoritative: token-row-derived
    presentedClientId: clientIdValue,                 // forensic: what the caller claimed
    familyId: ...,
    reason: ...,
  }
  ```
- Invariants:
  - I1 (app-enforced): replay/race_lost audit `metadata.clientId` derives from the token row whenever the row exists (it always does on these two outcomes — they require a matched `tokenHash`).
- Forbidden patterns:
  - pattern: `clientId: clientIdValue` alone (without `storedClientId`) inside the REPLAY / CONCURRENT_ROTATION audit metadata blocks of `src/app/api/mcp/token/route.ts` — reason: reverting to body-derived attribution is the finding itself.
- Acceptance criteria:
  - AC1: oauth-server test — replay outcome includes `storedClientId` equal to the row's client public id even when `params.clientId` is a lie. This MUST be a genuinely NEW test case with a deliberately mismatched clientId (e.g. `clientId: "mcpc_ATTACKER_LIE"` against the fixture's `mcpClient.clientId = "mcpc_test"`) — NOT a parametrization of the existing replay test at `oauth-server.test.ts:1232`, which passes the row's own clientId so `storedClientId` and the presented value would coincide and the assertion could not distinguish them (review T4).
  - AC2: route test — replay audit call's `metadata.clientId` equals the stored id, `metadata.presentedClientId` equals the (different) body value.
  - AC3: no change to defense behavior — family revocation still fires on replay regardless of presented clientId (existing tests stay green).
- Consumer-flow walkthrough:
  - Consumer audit-log UI / CSV / forwarding read `metadata` as opaque JSON (no schema on metadata keys) — additive keys are safe; `docs/operations/audit-log-reference.md` is grep-checked in Phase 2 and updated if it enumerates this action's metadata keys.
  - Consumer `route.ts` reads `{ storedClientId, tenantId, familyId, reason }` from the error return — all present in the locked shape.

#### C7 — Operator docs: Tailscale Edge-path boundary (P5)

- Files: `docs/security/policy-enforcement.md` (primary — expand the `tailscaleEnabled` row/section), plus a cross-reference in `docs/operations/deployment.md` if it discusses network restriction (Phase 2 grep decides; do not duplicate prose — link).
- Content (English, mirroring the code comment at `src/lib/auth/policy/access-restriction.ts:149-163`): the Edge/proxy path admits ANY Tailscale peer whose source IP is in CGNAT `100.64.0.0/10` — it does NOT verify tenant-tailnet membership; exact-tailnet WhoIs verification runs only in Node.js route handlers (Bearer/token flows); tenants needing strict per-tenant browser isolation must additionally scope `allowedCidrs`; Tailscale ACLs remain the operator's primary isolation control.
- Acceptance criteria: AC1 — doc section exists, states the boundary in those terms, and links the code path. No behavior change.
- Consumer-flow walkthrough: N/A (docs).

## Go/No-Go Gate

| ID  | Subject                                                        | Status |
|-----|----------------------------------------------------------------|--------|
| C1  | HIBP cache bounded FIFO eviction                               | locked |
| C2  | @browser-redirect exemption hardening (guard + markers)        | locked |
| C3  | Step-up id↔path manifest + new-call-site detector              | locked |
| C4  | CSV leading-whitespace trigger (app + CLI + round-trip)        | locked |
| C5  | Worker policy manifest + enforcement test                      | locked |
| C6  | Replay audit stored clientId                                   | locked |
| C7  | Tailscale Edge-path operator docs                              | locked |

Locked 2026-07-11 after 3 review rounds (7 findings R1 → 1 R2 → 0 R3; see security-review-followups-review.md).

## Testing strategy

- Unit (vitest root): C1 route eviction tests; C4 app regex/escape tests + import round-trip; C5 manifest enforcement test; C6 oauth-server + token-route tests.
- Unit (vitest cli): C4 CLI twin tests (parity cases extended identically). `cd cli && npm run build` (ESM `.js` import check) since cli is touched.
- Guard self-tests (`scripts/__tests__/*.test.mjs`): C2 + C3 fixtures, each new failure mode proven able to fire (RT7); guard remains VE2-safe (no Prisma import).
- Denial/negative tests follow RT8 where applicable (C1 AC1 asserts the upstream fetch mock was NOT called on cache hit).
- Full gates before completion: `npx vitest run`, `npx next build`, `cd cli && npm run build && npx vitest run`, `bash scripts/pre-pr.sh` (extension untouched → extension jobs still run via pre-pr as usual).

## Considerations & constraints

- Commit split: one logical commit per contract (C1..C7), plan+review docs committed per triangulate phase convention. Single PR at the end (per `feedback_pr_cadence_aggregate`).
- C3 detector is deliberately best-effort; its residual is explicitly documented (SC1). It must never produce false *negatives relative to today* (it only adds detection).
- Pre-1.0: no migration shims; none of the changes alter storage or wire formats (C6 metadata is additive JSON).
- No i18n/user-facing strings change (guards, docs, metadata only) — R37 N/A expected.

### Scope contract

- SC1: Full per-call-site path resolution for step-up client coverage (raw template literals, prop-indirection) — out of scope; residual documented in guard header. Owner: future escalation noted in `check-step-up-client-coverage.sh` KNOWN LIMITATIONS.
- SC2: HIBP cache Redis migration — out of scope; existing `TODO` comment in `hibp/route.ts` owns it.
- SC3: Runtime/behavioral enforcement of worker doc fields (idempotency proofs, retry integration tests) — out of scope; C5 governs by manifest + review, same trust level as route manifest `handlerAuthReason`.
- SC4: Per-tenant tailnet WhoIs verification on the Edge path — out of scope (architecturally impossible in Edge runtime; accepted boundary per #651 S5); C7 documents it.
- SC5: Audit emission for `revoked`/`expired`/`not_found` refresh outcomes — out of scope; today's route only audits replay/concurrent-rotation and this PR does not widen audit surface.

## User operation scenarios

1. Watchtower user runs a password-health scan hammering `/api/watchtower/hibp` with >5,000 distinct prefixes in 5 min (pathological): cache stays bounded, hot prefixes from the current scan stay cached, no full-cache stampede against HIBP.
2. A user exports their vault to CSV where a password is `  =2+SUM(A1:A9)` (leading spaces + formula): Excel shows literal text; re-importing the same CSV restores the exact original password bytes.
3. A CLI user runs `passwd-sso export --format csv` with the same value: identical neutralization (parity).
4. An attacker replays a stolen, already-rotated MCP refresh token while presenting a *different* client_id in the body: family is revoked (unchanged), and the audit record now attributes the replay to the real client (stored id), with the attacker-claimed id preserved as `presentedClientId`.
5. A developer adds a new step-up-gated route without a manifest entry, or a new UI page calling `/api/tenant/policy` PATCH without a `@stepup` marker: CI fails with an actionable message.
6. A developer adds a new background worker without a manifest entry: `worker-policy-manifest.test.ts` fails.
7. An operator on Tailscale reads `policy-enforcement.md` and correctly concludes they need `allowedCidrs` for strict per-tenant isolation of browser flows.

## Implementation Checklist

Batches (disjoint file sets; one logical commit per contract):
- Batch A (C1): `src/app/api/watchtower/hibp/route.ts` (eviction block only), `src/app/api/watchtower/hibp/route.test.ts` (new cap tests, vi.resetModules + dynamic import).
- Batch B (C4): `src/lib/format/csv-escape.ts` + `cli/src/lib/csv-escape.ts` (byte-identical regex), `src/lib/format/csv-escape.test.ts` + `cli/src/__tests__/unit/csv-escape.test.ts` (identical new cases), `src/components/passwords/import/password-import-parsers.ts` (comment extension only), round-trip cases in `password-import-parsers.test.ts:204` scaffold via parseCsvLine/parseCsv.
- Batch C (C2+C3): `scripts/checks/check-step-up-client-coverage.sh`, `scripts/checks/stepup-client-exempt.txt` (header note only if needed), NEW `scripts/checks/stepup-route-paths.json`, 3 route files + 3 sibling route.test.ts (markers only), `scripts/__tests__/check-step-up-client-coverage.test.mjs` (fixtures for 5 new failure modes).
- Batch D (C5): NEW `scripts/checks/worker-policy-manifest.json`, NEW `src/__tests__/workers/worker-policy-manifest.test.ts` (filesystem-only).
- Batch E (C6): `src/lib/mcp/oauth-server.ts` (replay/race_lost outcomes + error shape), `src/app/api/mcp/token/route.ts` (audit metadata), `src/lib/mcp/oauth-server.test.ts` + `src/app/api/mcp/token/route.test.ts` (new adversarial cases).
- Batch F (C7): `docs/security/policy-enforcement.md` (+ cross-ref in deployment docs if applicable).

Shared assets to reuse (no reimplementation): `CSV_FORMULA_TRIGGER_RE` (SSoT, app+CLI twins), `MS_PER_*` time constants, `logAuditAsync`, existing guard fixture harness (`STEPUP_CLIENT_GUARD_*` env redirection), `route-policy-manifest.test.ts` walk/assert pattern.

Test trees affected (R19): co-located route tests (hibp, mcp token, mcp/mobile authorize), `src/lib/mcp/oauth-server.test.ts`, `src/lib/format/csv-escape.test.ts`, `cli/src/__tests__/unit/csv-escape.test.ts`, `src/components/passwords/import/password-import-parsers.test.ts` (single tree each — no parallel-tree duplication found for the touched symbols; e2e references none of them).

CI gate parity: all touched surfaces gate through `scripts/pre-pr.sh` (44 checks; includes the step-up guard at pre-pr.sh:166 and full vitest at :495) + CI static-checks (PRE_PR_STATIC_ONLY, no prisma generate — guard edits must stay pure text/fs). New vitest tests ride the normal test job. No new CI wiring needed. Deferred parity gaps: none.
