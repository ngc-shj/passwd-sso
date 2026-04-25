# Plan: env-config-sync-and-generator

Date: 2026-04-24
Author: Claude (Opus 4.7) on behalf of NOGUCHI Shoji
Revision: round-3 (Round 1 + Round 2 findings fully reflected — cumulative 2 Critical, 25 Major, 26 Minor addressed)

---

## Project context

- **Type**: `web app` (Next.js 16 + Prisma 7 + Docker; Node 22 runtime)
- **Test infrastructure**: `unit + integration + CI/CD` (vitest + real-DB integration tests, GitHub Actions)
- **Constraints carried over from Round 1**:
  - `src/lib/env.ts` (Zod schema) is the most authoritative description but **not yet complete** — a ripgrep pass over `src/` shows ≥20 production readers missing.
  - `.env.example` is hand-edited today; drift vs. `env.ts` and `docker-compose*.yml` is present.
  - Docker Compose has three overlays (`override`, `ha`, `logging`) each with their own env expectations, some injected as plain literals rather than `${VAR:?...}` substitution — the drift checker MUST handle all forms.
  - Worker (`scripts/audit-outbox-worker.ts`) runs in a separate process and **does not import `src/lib/env.ts`** today. Plan must fix this (T9 Option a).
  - CLI/extension packages have their own config — OUT OF SCOPE.

---

## Objective

1. **Audit**: Replace the guessed D1-D8 with a ripgrep-derived authoritative inventory of every production `process.env.*` reader. Correct all drifts among `.env.example`, `src/lib/env.ts`, `docker-compose*.yml`, `scripts/*.sh`, `.github/workflows/*.yml`, and `README.md`.
2. **SSOT**: Establish `src/lib/env.ts` (Zod) as the Single Source of Truth for every server-read variable, with one explicit documented exception: `SHARE_MASTER_KEY_V{N>10}` variadic keys (we model V1–V10 directly; higher versions require a follow-up PR that tests key-rotation paths).
3. **Generate**: Build an interactive env-file generator (Node `tsx`, **no new deps**) that asks questions, writes a valid `.env.local`, and re-validates against the schema before committing the write.
4. **Guard**: Add a CI check and `package.json` npm script that fail when `.env.example`, schema, allowlist, or docker-compose declare divergent env surfaces.
5. **Protect secrets**: Gitignore patterns, atomic file creation, input sanitization, transcript hygiene, CODEOWNERS — all specified below.

Non-goal: migrate all `process.env.X` call sites to `import { env }`. Scheduled as Phase 2 per `env.ts` header.

---

## Requirements

### Functional

- **F-Req-1 Schema completeness**: Every var in the ripgrep-derived inventory §A-Table-1 is either (a) declared in `src/lib/env.ts` Zod schema, or (b) placed in `scripts/env-allowlist.ts` with a required `justification` string (≥40 chars) and a `consumers: string[]` field citing the exact file that reads it. Worker-process vars (see T9 fix) are validated by the worker importing `envObject.pick({...})` (base object, not the refined `envSchema` — F16).
- **F-Req-2 `.env.example` generation**: Generated from `src/lib/env.ts` schema shape + `scripts/env-descriptions.ts` sidecar. **Sidecar is authoritative for output ordering** (each entry has `group` and `order` fields). The generated file is committed. Re-running the generator on unchanged inputs yields byte-identical output on Linux, macOS, and under `LANG=C`/`LANG=ja_JP.UTF-8`.
- **F-Req-3 Interactive generator**: `npm run init:env` launches a guided TUI that:
  - Presents each variable with name, description, required/optional, a default (from Zod) or an example.
  - Supports three preset profiles: `dev`, `production`, `ci`.
  - **Profile semantics (from F9 fix):**
    - `dev`: permissive; all `superRefine` production requirements skipped; generator auto-creates master keys; Docker Compose defaults pre-filled.
    - `ci`: mirrors `.github/workflows/ci.yml` — generates deterministic placeholder values that satisfy the schema.
    - `production`: **requires the user to paste real secrets (provider IDs, SMTP credentials, etc.)**; the generator cannot invent these. If any required value is left blank after **max 5 re-prompt attempts**, the generator exits non-zero with a clear message. An `--abort-on-missing` flag skips the re-prompt loop entirely and exits on the first missing value.
  - Auto-generates cryptographic values (64-char hex) on user confirmation via Node's `crypto.randomBytes(32).toString("hex")`. **No `openssl` shell-out.**
  - **Atomic write** (§NF-4 details): `fs.open(tmpPath, "wx", 0o600)` → `write` → `fchmod(fd, 0o600)` defensively → `fsync(fd)` → `close` → `rename(tmpPath, ".env.local")`. On `EEXIST` abort with "another init-env is running or crashed; delete .env.local.tmp and retry".
  - Re-validates the resulting `.env.local` against the Zod schema before writing. On validation failure, re-prompts only the specific failing fields (max 5 attempts per field).
  - **Never overwrites existing `.env.local` silently** — prompts `[Overwrite / Backup-and-overwrite / Abort]`. Backup path: `.env.local.bak-YYYYMMDD-HHMMSS` (UTC) with the **same `0o600` mode** as the primary file.
  - Works fully offline. No network calls.
  - **Pluggable prompt layer (T4 fix)**: `scripts/init-env.ts` exports `run(opts: { stdin: Readable; stdout: Writable; stderr: Writable; now: () => Date; args: string[] })`. The CLI entry wires `process.stdin` etc.; tests use `node:stream` `PassThrough` streams to feed answers with trailing `\n`.
- **F-Req-4 Drift check**: `npm run check:env-docs` compares:
  1. Zod-declared names vs `.env.example` keys.
  2. Zod-declared names vs `.github/workflows/ci.yml` hard-coded env block.
  3. `docker-compose*.yml` env declarations (all overlays) vs `Zod ∪ allowlist`.
  4. Allowlist entries vs actual `process.env.X` reads in `src/**/*.ts` (dead allowlist entries reported).
  5. Allowlist entries vs docker-compose references (stale allowlist entries reported).
  6. Sidecar `env-descriptions.ts` keys vs Zod schema shape (runtime check even if TS catches it).
  7. `.env.example` duplicate keys and commented-required keys.

  Exit 0 when in sync; exit 1 with a grouped diff report otherwise. Wired into `scripts/pre-pr.sh` and `.github/workflows/ci.yml`.

### Non-functional

- **NF-1 Zero new deps**: **No new runtime OR dev dependency is added.** The interactive generator uses only `node:readline/promises`. The drift checker's YAML parser uses `js-yaml` **only if already present in `package.json`**; otherwise a minimal in-plan YAML subset parser (compose files use a stable, limited YAML subset). The plan records the decision with the output of `node -e "console.log(Object.keys(require('./package.json').dependencies).includes('js-yaml'), Object.keys(require('./package.json').devDependencies).includes('js-yaml'))"` at step 1. No `@clack/prompts` — even its transitive presence in `package-lock.json` via `better-result` does NOT permit direct import (supply-chain fragility).
- **NF-2 Node-only, cross-platform**: No shell scripts beyond the existing `scripts/pre-pr.sh` edit. The generator and drift-checker must work on Linux/macOS/WSL.
- **NF-3 Deterministic output**: `.env.example` generation is stable across platforms and locales:
  1. Key ordering driven by sidecar's `(group, order)` tuple — NOT `envObject.shape` iteration (see F16).
  2. No `Date.now()` / `new Date()` calls during generation.
  3. No `process.platform` branches that change output content (warnings may differ by platform; the file itself must not).
  4. All string sorting uses `new Intl.Collator(locale, { sensitivity: "variant" }).compare` with locale passed in explicitly (default `"en"`); never relies on `process.env.LANG` or `String.prototype.localeCompare()` default locale.
  5. **Determinism tests (T26 redesigned)**: (a) generate twice in the same process, assert byte-identical; (b) unit-test the sort function with fixture `["İ", "I", "i", "a", "Z"]` under `locale="en"` and `locale="tr"`, asserting each produces a stable (sortable) ordering and that the "en" output matches the committed snapshot used by the `.env.example` generator. **No OS-locale dependency** — the test cannot silently skip on CI runners that lack `tr_TR.UTF-8` (T26 resolved).
- **NF-4 Secret hygiene**:
  1. Terminal transcript contains `[generated]` in place of secrets unless the user passes `--print-secrets`.
  2. `--print-secrets` and `--non-interactive` are **mutually exclusive**; generator exits 1 with a clear error if both are passed.
  3. Validation-error re-prompts show `path` and `message` only — **never the rejected value**.
  4. File written with mode `0600` via the atomic procedure described in F-Req-3. On Windows (non-WSL), `fs.chmod` is a no-op; the generator prints `Warning: file permission cannot be restricted on this platform. Treat .env.local as sensitive.` before every write and backup step.
  5. Backup files (`.env.local.bak-*`) are written with the same mode and atomic procedure.
  6. **Secret-pattern emit guard (applies to BOTH `init:env` AND `generate:env-example`, S16)**: At emit time, every value being written is compared against `/^[A-Fa-f0-9]{32,}$/`. If matched AND the field is NOT marked `secret: true` in the sidecar, abort with a clear error (sidecar bug). If matched AND the field IS marked `secret: true`, behavior differs by target: `init:env` writes the value verbatim (it IS the user-supplied secret); `generate:env-example` DROPS the value and replaces with the canonical placeholder **`# generate via: npm run generate:key`** (S21 fix — use the existing `package.json` script rather than a copy-paste one-liner with embedded quotes, which would land in operator shell history on execute). Committed templates never contain plausible-hex strings. Enforced by `scripts/__tests__/generate-env-example.test.mjs` asserting zero 32+ hex matches in the generated file.
  7. Generator refuses to write if **`git status --porcelain -z`** (NUL-separated for S26 safe filename parsing) shows any target path currently tracked by git (entries in the index with `M`/`A`/`R`/`C` codes). This is defense-in-depth against a missing gitignore rule. Error message: `"Refusing to write: target path <path> is tracked by git (status: <code>). Run 'git rm --cached <path>' to untrack before re-running. Gitignored-but-untracked paths are fine."` This refusal is INTENTIONAL — `.env.local` tracked by git is the pathological case we defend against; a force-untracked file is untracked and invisible to `git status`, so it does not trigger the refusal.
- **NF-5 No regression in boot**: Every newly-declared Zod field starts `.optional()` OR retains its current runtime default verbatim. Explicit anti-regressions:
  - `HEALTH_REDIS_REQUIRED` default **stays `false`** (`src/lib/health.ts:63` current behavior); plan does NOT flip it.
  - `LOG_LEVEL` default **stays `"info"`** (`src/lib/logger.ts:18` current behavior). **A1's production `superRefine` (forbid debug/trace) is DEFERRED to a follow-up PR** (S15): this PR keeps the enum + default only, so existing `LOG_LEVEL=debug` production deployments continue to boot.
  - `SMTP_PORT` default **stays `587`** (`src/auth.config.ts:94`, `src/lib/email/index.ts:25`). One documented behavior tightening (F22): empty-string `SMTP_PORT=` now fails boot with a clear Zod error instead of silently passing NaN to nodemailer. Recorded in the release notes.
  - `SAML_PROVIDER_NAME` default stays `"SSO"` (already in schema).
  - `SHARE_MASTER_KEY_CURRENT_VERSION.max(100)` is **preserved** (F17). V1..V10 become explicit Zod fields; V11..V100 remain handled by `superRefine` via `process.env[...]` as a documented exception recorded in A-Table-2.
  - `NEXT_PUBLIC_*` consumer-side fallbacks (e.g. `process.env.NEXT_PUBLIC_APP_NAME ?? "passwd-sso"` at `src/lib/constants/app.ts:7`) **MUST NOT be removed** (F20). Next.js inlines these into the client bundle at build time; server-side Zod defaults are a safety net only for server-side reads. A future "cleanup" PR that deletes the `??` fallbacks would break zero-config client bundles.
- **NF-6 Pre-merge boot verification (mandatory gate)**: On a fresh clone with an **unchanged existing `.env.local`**:
  1. `npm run dev` boots without new env errors (records `/tmp/boot-log-dev.txt`). **This is the primary Zod gate** — it invokes `src/instrumentation.ts → register() → import "@/lib/env"`.
  2. `npm run build` — type-check and production-bundle; **does NOT exercise env.ts** per `src/instrumentation.ts:1-6`. Kept as a TypeScript regression gate, explicitly labeled as such in the deviation log.
  3. `npm run start` with the production bundle — exercises `register()` in production mode, proving production boot validates.
  4. `npm run worker:audit-outbox` (background, short-duration): prove the worker's new `envObject.pick({...})` validation passes with the existing `.env.local` that has no `OUTBOX_WORKER_DATABASE_URL` set (must fall back to `DATABASE_URL`).
  Record the four outputs in the deviation log. Any new failure that was not failing on `main` blocks merge.

### Security (S-level obligations)

- **SEC-1 Gitignore completeness**: Before any generator code lands, `.gitignore` gains the following lines:
  ```
  # env generator artifacts (secrets)
  .env.local.tmp
  .env.local.tmp.*
  .env.local.bak
  .env.local.bak-*
  .env.local.bak.*
  ```
  Verified by a dedicated test (`scripts/__tests__/check-env-gitignore.test.mjs`) that runs `git check-ignore` on representative paths and asserts each is ignored.
- **SEC-2 stdin sanitization**: The generator's prompt layer always double-quotes written values using dotenv-compatible escaping (`"`, `\`, `\n`, `\r`, `$`). Values containing `\n`, `\r`, or `\x00` are rejected at prompt time. Keys outside `[A-Z_][A-Z0-9_]*` are impossible because the generator iterates the schema shape (never asks for key names).
- **SEC-3 Allowlist governance**: `scripts/env-allowlist.ts` type:
  ```ts
  type AllowlistEntry = {
    justification: string;  // regex-validated: /^.{40,}$/
    consumers: readonly string[];  // non-empty file paths
    reviewedAt: string;  // ISO-8601 date
  };
  ```
  The drift-checker validates the type at runtime and fails if any entry violates the regex or lacks `consumers`. It ALSO fails if any allowlist key appears as `process.env.X` in `src/**/*.ts` (that would mean the app reads it → must be in Zod, not allowlist).
- **SEC-4 CODEOWNERS and drift-roster (S18)**: The existing `.github/CODEOWNERS` (verified present, 1811 bytes) gains a single line:
  ```
  /scripts/env-allowlist.ts                    @ngc-shj
  ```
  **AND** `scripts/check-codeowners-drift.mjs` ROSTER_GLOBS gains `"scripts/env-allowlist.ts",` in the SAME commit. Without the roster entry, a future PR that drops the CODEOWNERS line would not be detected — the existing `check-codeowners-drift` CI guard is the mechanism that makes SEC-4 self-healing. Both edits land together with the allowlist file creation.
- **SEC-5 gitleaks in pre-pr**: `scripts/pre-pr.sh:45-49` currently skips when gitleaks is not installed. Plan upgrades this to a **Node-based** fallback that catches hex leaks portably across Linux/macOS/WSL without relying on GNU-grep extensions (S19 — BSD grep on macOS treats `\b` inconsistently; POSIX `grep -E` does not mandate `\b`):
  ```
  if ! command -v gitleaks >/dev/null 2>&1; then
    # S19/S27 safe fallback: use node (already available — package.json runtime).
    # No shell-regex dialect issues; safe filename handling via -z.
    LEAK_OUTPUT=$(node scripts/lib/hex-leak-scan.mjs 2>&1) || {
      echo "ERROR: 64-char hex secret detected in staged diff (fallback scan):"
      echo "$LEAK_OUTPUT"
      echo "Install gitleaks for full-coverage scanning (brew install gitleaks / apt install gitleaks)."
      exit 1
    }
    echo "WARNING: gitleaks not installed; best-effort Node fallback passed (not a gitleaks substitute)."
  fi
  ```
  The `scripts/lib/hex-leak-scan.mjs` helper:
  - Reads staged file list via `git diff --cached --name-only -z` (NUL-separated; S27 filename-injection-safe).
  - For each staged file except `.env.example`, runs `git diff --cached -- <path>` as an argv array (no shell interpolation).
  - Scans every added line (starts with `+` but not `+++`) for 64-char hex runs using JS regex `/(?:^|[^a-f0-9])([a-f0-9]{64})(?:$|[^a-f0-9])/i` — character-class boundaries replace the non-portable `\b` (S19).
  - **Line-context filter (S20)**: within a per-file state machine, track whether the current line is (a) a dotenv comment (`# ...`), (b) a single-line `// ...` comment, (c) inside a `/* ... */` block comment. Lines matching (a)/(b)/(c) are exempt. Block-comment state spans multiple diff lines — tracked with a running flag updated on each added line.
  - Exits 0 when no match; exits 1 with path:line:snippet when a non-exempt match is found. Snippet shows the first 8 hex chars + `...` (never the full secret).

  Explicit note: the fallback is defense-in-depth, **not a gitleaks substitute**. Full coverage requires `gitleaks` binary. Plan adds `scripts/__tests__/pre-pr-hex-fallback.test.mjs` with five inputs (expanded from Round 2's three):
  - (a) hex in dotenv line (`+SHARE_MASTER_KEY=<64hex>`) → exits 1
  - (b) hex in `.ts` string literal (`+const K = "<64hex>"`) → exits 1
  - (c) hex in a dotenv comment line (`+# example: <64hex>`) → exits 0 (exempt)
  - (d) hex inside `/* ... */` block comment in `.ts` → exits 0 (exempt, state machine tracks block context)
  - (e) hex in a Markdown fenced code block (`+    <64hex>` inside ```` ``` ```` section) → exits 1 (conservative fail-closed per S20 refinement — Markdown code blocks are not reliably distinguishable from real source in a unified diff)

  Precedent: the existing `scripts/move-and-rewrite-imports.mjs`, `check-codeowners-drift.mjs`, and `check-licenses.test.mjs` pattern already establishes Node-based staged-diff scanning.

---

## Technical approach

### A. Authoritative inventory (replaces Round-1 D1-D8)

#### A-Table-1: production `process.env.*` readers from ripgrep (`src/**/*.ts` + `scripts/audit-outbox-worker.ts`, test files excluded)

| ID | Variable | Reader (file:line) | Action | Rationale |
|----|----------|-------------------|--------|-----------|
| — | DATABASE_URL | `src/lib/prisma.ts:56`, `scripts/audit-outbox-worker.ts:8` | **Keep (already Zod)** | — |
| — | MIGRATION_DATABASE_URL | `prisma.config.ts` | **Keep (already Zod)** | — |
| — | NODE_ENV | many | **Keep (already Zod)** | — |
| — | AUTH_SECRET, AUTH_URL, AUTH_GOOGLE_ID/SECRET, AUTH_JACKSON_ID/SECRET, JACKSON_URL, GOOGLE_WORKSPACE_DOMAINS, AUTH_TENANT_CLAIM_KEYS, SAML_PROVIDER_NAME, EMAIL_PROVIDER | env.ts + consumers | **Keep (already Zod)** | — |
| — | SHARE_MASTER_KEY, SHARE_MASTER_KEY_CURRENT_VERSION, ADMIN_API_TOKEN, VERIFIER_PEPPER_KEY, REDIS_URL, APP_URL, TRUSTED_PROXIES, TRUST_PROXY_HEADERS, CSP_MODE, BLOB_BACKEND, BLOB_OBJECT_PREFIX, AUDIT_LOG_FORWARD, AUDIT_LOG_APP_NAME, AWS_REGION, S3_ATTACHMENTS_BUCKET, AZURE_STORAGE_ACCOUNT, AZURE_BLOB_CONTAINER, AZURE_STORAGE_CONNECTION_STRING, AZURE_STORAGE_SAS_TOKEN, GCS_ATTACHMENTS_BUCKET, WEBAUTHN_RP_ID, WEBAUTHN_RP_NAME, WEBAUTHN_RP_ORIGIN, WEBAUTHN_PRF_SECRET, DIRECTORY_SYNC_MASTER_KEY, OPENAPI_PUBLIC, KEY_PROVIDER, SM_CACHE_TTL_MS, DB_POOL_MAX, DB_POOL_CONNECTION_TIMEOUT_MS, DB_POOL_IDLE_TIMEOUT_MS, DB_POOL_MAX_LIFETIME_SECONDS, DB_POOL_STATEMENT_TIMEOUT_MS | env.ts + consumers | **Keep (already Zod)** | — |
| A1 | LOG_LEVEL | `src/lib/logger.ts:18` | **Add to Zod**: `z.enum(["trace","debug","info","warn","error","fatal"]).default("info")`. **The production debug/trace ban is DEFERRED** (S15) — see NF-5. | Production reader, pino levels |
| A2 | HEALTH_REDIS_REQUIRED | `src/lib/health.ts:63` | **Add to Zod**: `z.enum(["true","false"]).default("false").transform(v => v === "true")` (default STAYS `false` — S3/T8) | Production reader; currently `=== "true"` comparison, unset ⇒ `false` |
| A3 | NEXTAUTH_URL | `src/app/api/sessions/helpers.ts:10` | **Add to Zod**: `nonEmpty.optional()` as URL (fallback for AUTH_URL in legacy Auth.js deployments) | Auth.js migration artifact |
| A4 | EMAIL_FROM | `src/lib/email/index.ts:14`, `src/auth.config.ts:101` | **Add to Zod**: `z.string().optional()` (current default `"noreply@localhost"` preserved in consumer) | — |
| A5 | RESEND_API_KEY | `src/lib/email/index.ts:17` | **Add to Zod**: `nonEmpty.optional()`; `superRefine`: required when `EMAIL_PROVIDER==="resend"` | Secret |
| A6 | SMTP_HOST | `src/lib/email/index.ts:24`, `src/auth.config.ts:91`, currently escape-hatched at `env.ts:275` | **Add to Zod as a first-class field** and **remove the `process.env.SMTP_HOST` read** from `superRefine` (D6 done correctly this time) | — |
| A7 | SMTP_PORT | `src/lib/email/index.ts:25`, `src/auth.config.ts:94` | **Add to Zod**: `z.coerce.number().int().min(1).max(65535).default(587)` | Keep current behavior |
| A8 | SMTP_USER | `src/lib/email/index.ts:33`, `src/auth.config.ts:96` | **Add to Zod**: `z.string().optional()` | — |
| A9 | SMTP_PASS | `src/lib/email/index.ts:34`, `src/auth.config.ts:97` | **Add to Zod**: `z.string().optional()` | Secret (marked `secret: true` in sidecar) |
| A10 | AZURE_KV_URL | `src/lib/key-provider/index.ts:31` | **Add to Zod**: `nonEmpty.optional()`; `superRefine`: required when `KEY_PROVIDER==="azure-kv"` | — |
| A11 | GCP_PROJECT_ID | `src/lib/key-provider/index.ts:41` | **Add to Zod**: `nonEmpty.optional()`; `superRefine`: required when `KEY_PROVIDER==="gcp-sm"` | — |
| A12 | TAILSCALE_API_BASE | `src/lib/services/tailscale-client.ts:86` | **Add to Zod**: `z.string().optional()` | Operational |
| A13 | TAILSCALE_SOCKET | `src/lib/services/tailscale-client.ts:87` | **Add to Zod**: `z.string().optional()` | Operational |
| A14 | SENTRY_DSN | `src/instrumentation.ts:20,28`, `src/lib/http/with-request-log.ts:65` | **Add to Zod**: `z.string().url().optional()`. Sidecar description MUST warn: `"Server-only DSN. DO NOT reuse the same value as NEXT_PUBLIC_SENTRY_DSN — use a dedicated client DSN with narrower scope for browser error reporting (S17)."` | Operational; public-key segment is project-sensitive — mark `secret: true` in sidecar |
| A15 | REDIS_SENTINEL | `src/lib/redis.ts:14` | **Add to Zod**: `z.enum(["true","false"]).default("false").transform(v => v === "true")` | HA overlay |
| A16 | REDIS_SENTINEL_HOSTS | `src/lib/redis.ts:15` | **Add to Zod**: `z.string().optional()` (comma-separated); `superRefine`: required when `REDIS_SENTINEL` true | HA overlay |
| A17 | REDIS_SENTINEL_MASTER_NAME | `src/lib/redis.ts:16` | **Add to Zod**: `z.string().default("mymaster")` | HA overlay |
| A18 | REDIS_SENTINEL_PASSWORD | `src/lib/redis.ts:17` | **Add to Zod**: `z.string().optional()` | HA overlay, **secret** |
| A19 | REDIS_SENTINEL_TLS | `src/lib/redis.ts:18` | **Add to Zod**: `z.enum(["true","false"]).default("false").transform(v => v === "true")` | HA overlay |
| A20 | OUTBOX_BATCH_SIZE | `src/lib/constants/audit/audit.ts:680` | **Add to Zod**: `z.coerce.number().int().min(1).max(10000).default(500)` | Worker tuning |
| A21 | OUTBOX_POLL_INTERVAL_MS | audit.ts:681 | **Add to Zod**: `z.coerce.number().int().min(100).max(60000).default(1000)` | Worker tuning |
| A22 | OUTBOX_PROCESSING_TIMEOUT_MS | audit.ts:682 | **Add to Zod**: `z.coerce.number().int().min(10000).max(3600000).default(300000)` | Worker tuning |
| A23 | OUTBOX_MAX_ATTEMPTS | audit.ts:683 | **Add to Zod**: `z.coerce.number().int().min(1).max(100).default(8)` | Worker tuning |
| A24 | OUTBOX_RETENTION_HOURS | audit.ts:684 | **Add to Zod**: `z.coerce.number().int().min(1).max(168).default(24)` | Worker tuning |
| A25 | OUTBOX_FAILED_RETENTION_DAYS | audit.ts:685 | **Add to Zod**: `z.coerce.number().int().min(1).max(3650).default(90)` | Worker tuning |
| A26 | OUTBOX_READY_PENDING_THRESHOLD | audit.ts:686 | **Add to Zod**: `z.coerce.number().int().min(100).default(10000)` | Worker tuning |
| A27 | OUTBOX_READY_OLDEST_THRESHOLD_SECS | audit.ts:687 | **Add to Zod**: `z.coerce.number().int().min(30).max(86400).default(600)` | Worker tuning |
| A28 | OUTBOX_REAPER_INTERVAL_MS | audit.ts:688 | **Add to Zod**: `z.coerce.number().int().min(5000).max(3600000).default(30000)` | Worker tuning |
| A29 | OUTBOX_WORKER_DATABASE_URL | `scripts/audit-outbox-worker.ts:8` | **Add to Zod**: URL-validated optional (falls back to `DATABASE_URL`). Worker re-imports `envObject.pick({...})` (full enumerated list in step 5, F21) and validates at startup (T9 Option a + F16) | — |
| A30 | NEXT_PUBLIC_APP_NAME | `src/lib/constants/app.ts:7`, `src/lib/email/templates/layout.ts:10` | **Add to Zod**: `z.string().default("passwd-sso")`. Document in sidecar: build-time inlined into client bundle AND runtime-read on server | — |
| A31 | NEXT_PUBLIC_BASE_PATH | many | **Add to Zod**: `z.string().default("")`. Same dual-use doc | — |
| A32 | NEXT_PUBLIC_CHROME_STORE_URL | `src/components/layout/header.tsx:28` | **Add to Zod**: `z.string().url().optional()` | — |
| A33 | NEXT_PUBLIC_SENTRY_DSN | `src/app/global-error.tsx:33` | **Add to Zod**: `z.string().url().optional()` | — |
| ~~A34~~ | NEXT_DEV_ALLOWED_ORIGINS | `next.config.ts:28` | **MOVED to A-Table-2 allowlist** (F19) — `next.config.ts` is evaluated by the Next CLI before `@/lib/env` runs; any server-side Zod default is unreachable by the reader. | — |
| **D6-split** | SHARE_MASTER_KEY_V1 .. SHARE_MASTER_KEY_V10 | `src/lib/env.ts:294,306` (bracket access in `superRefine`), `src/lib/key-provider/env-provider.ts:61` (bracket access in `getShareMasterKeyV1`). NOTE: `crypto-server.ts:38` and `base-cloud-provider.ts:90` read only CURRENT_VERSION — NOT V{N} (F18) | **Add V1..V10 as explicit Zod fields `hex64.optional()` in the base `envObject`** (F16 + S4 Option a). After refactor, `superRefine` reads `data.SHARE_MASTER_KEY_V${n}` for 1..10 (schema-typed) and **falls back to `process.env[\`SHARE_MASTER_KEY_V${n}\`]` for 11..100** (documented exception in A-Table-2). `SHARE_MASTER_KEY_CURRENT_VERSION.max(100)` is **preserved** (F17 + NF-5). `env-provider.ts:61` is refactored to use `envObject.shape` lookup for V1..V10, bracket fallback for V11..V100. | Close the dotenv escape hatch for the common version range; retain compatibility for deployments past V10 |

#### A-Table-2: allowlist (not Zod-declared; machine-checked)

| Variable | `consumers` | `justification` (≥40 chars) |
|----------|-------------|-----------------------------|
| JACKSON_API_KEY | `docker-compose.yml` | `Used only by BoxyHQ SAML Jackson container; never read by our Next app or worker. Declared as ${JACKSON_API_KEY:?...} required only at Jackson container start.` |
| PASSWD_OUTBOX_WORKER_PASSWORD | `scripts/set-outbox-worker-password.sh`, `infra/postgres/initdb/*.sh` | `Consumed only by the one-shot provisioning script that sets the passwd_outbox_worker DB role password. Not read by any running process.` |
| NEXT_RUNTIME | `src/instrumentation.ts:8`, `src/instrumentation.test.ts` | `Provided by the Next.js framework at runtime; user configuration has no effect. Value space is {nodejs, edge}. Read-only from our code.` |
| SENTRY_AUTH_TOKEN | `.env.example` doc reference only | `Build-time-only: consumed by the Sentry webpack plugin during npm run build for source-map upload. No runtime reader in our code.` |
| BASE_URL | `scripts/manual-tests/*.ts` | `Manual/REPL helper for ad-hoc testing; never read by the app or automated tests.` |
| APP_DATABASE_URL | `src/__tests__/db-integration/helpers.ts` | `Test helper override for integration tests that need a non-default app-role connection string; not read in production.` |
| NEXT_DEV_ALLOWED_ORIGINS | `next.config.ts:28` | `Read by the Next CLI at config-evaluation time, before @/lib/env runs; schema validation would be unreachable at the reader site. Comma-separated hostnames, enforced by Next's own dev-origin check (F19).` |
| `^SHARE_MASTER_KEY_V(1[1-9]\|[2-9]\d\|100)$` (regex) | `src/lib/env.ts:306` (superRefine), `src/lib/key-provider/env-provider.ts:61` (bracket fallback) | `Variadic master key slots for versions 11..100. V1..V10 are modeled as explicit Zod fields; V11+ remain accessed via process.env[...] in superRefine as a documented exception because adding 90 explicit fields would bloat the schema without proportional benefit. A follow-up PR will add explicit fields if any deployment rotates past V10.` |

All other `process.env.*` strings that appear only in `*.test.ts`/`*.test.tsx` files are considered test-local and do NOT require allowlist entries (the drift-checker excludes test-file paths).

**Allowlist shape supports regex keys (F23, F13)**: The `env-allowlist.ts` type permits either a literal string key or a `key: { type: "regex", pattern: string }` alternative form for variadic patterns. The drift-checker's "no app read without Zod or allowlist" rule matches actual `process.env.X` reader strings against all literal keys AND against the compiled regex patterns.

#### A-Table-3: `.env.example` cleanup

| Action | Variable | Rationale |
|--------|----------|-----------|
| **Remove** | `OUTBOX_FLUSH_INTERVAL_MS` (line 129) | Ghost — no reader in `src/` (F1). Documented as aspirational in `docs/archive/review/durable-audit-outbox-plan.md:296` but never implemented. Not adding to Zod. |
| **Add** | Every A1-A34 variable except `NEXT_RUNTIME` (framework-set) | Generated from the (schema, sidecar) pair — humans stop hand-editing. |
| **Add** | `HEALTH_REDIS_REQUIRED`, `REDIS_SENTINEL_*` (all five) | Documented under HA group with the `# HA-only` label. |
| **Add** | `SHARE_MASTER_KEY_V2..V10` | Commented-out placeholders with a note: `# Used only when SHARE_MASTER_KEY_CURRENT_VERSION is set to this version`. |

### B. `.env.example` generator

- **Location**: `scripts/generate-env-example.ts` (tsx).
- **Sidecar**: `scripts/env-descriptions.ts` — shape:
  ```ts
  // T22: enumerated groups — typos become compile errors.
  export const GROUPS = [
    "Application",
    "Database",
    "Auth",
    "Auth providers",
    "Vault keys",
    "WebAuthn",
    "Blob storage",
    "Email",
    "Logging",
    "Health",
    "Redis",
    "Outbox worker",
    "Key provider",
    "DB pool",
    "Reverse proxy",
    "Public (client-inlined)",
    "Sentry",
    "Tailscale",
    "Operational",
  ] as const;
  export type Group = typeof GROUPS[number];

  type SidecarEntry = {
    group: Group;            // constrained to GROUPS — T22 fix
    order: number;           // within-group ordinal
    description: string;     // 1-3 lines; lines <= 80 cols
    example?: string;        // placeholder shown in generated file
    secret?: boolean;        // triggers NF-4.6 emit-time check
    scope?: "runtime" | "build" | "framework-set";
  };
  export const descriptions: Record<keyof z.infer<typeof envObject>, SidecarEntry> = { ... };
  ```
  The `Record<keyof ..., SidecarEntry>` uses `envObject` (not `envSchema`) so the keyof resolves to the plain ZodObject shape (F16 interaction). The TypeScript constraint plus the runtime check in the drift-checker (§D check 6) keep schema + sidecar + group-name consistent.
- **Output**: grouped sections, stable ordering per `(group, order)`. Each entry formatted as:
  ```
  # <description line 1>
  # <description line 2>
  <KEY>=<example or empty>
  ```
- **`npm script`**: `"generate:env-example": "tsx scripts/generate-env-example.ts"`.

### C. Interactive generator

- **Location**: `scripts/init-env.ts` (tsx) with helper `scripts/lib/prompt.ts`.
- **API**: `export async function run(opts: { stdin, stdout, stderr, now, args }): Promise<number>` returning an exit code.
- **Library**: `node:readline/promises` only. No external TUI lib.
- **Flow**:
  1. Parse args: `--profile={dev|ci|production}`, `--print-secrets`, `--non-interactive` (reserved; errors `"Not implemented in this PR"`), `--abort-on-missing`. `--print-secrets` + `--non-interactive` ⇒ exit 1 (S8).
  2. Platform check: if `process.platform === "win32"`, print the NF-4.4 warning once.
  3. NF-4.7 safety: run `git status --porcelain -z` (NUL-separated, S26) and abort per NF-4.7 rules if any tracked-index status code covers the target path.
  4. Detect existing `.env.local` → prompt `[Overwrite / Backup-and-overwrite / Abort]`.
  5. **Prompt order (F24)**: decouple prompt order from file-write order. The generator computes two orderings over the schema fields:
     - **Prompt order**: (a) required-unconditionally (NODE_ENV=selected profile) first, (b) conditionally-required (e.g., SMTP_HOST if EMAIL_PROVIDER=smtp) next (re-evaluated after each answer), (c) optional with non-default value last. Within each tier, (group, order) is the stable tiebreaker. This lets production-profile users fail fast on missing provider secrets rather than typing 30 fields before hitting a blocker.
     - **File-write order**: pure sidecar (group, order) — unchanged, drives determinism (NF-3).
     For each schema field in prompt order:
     - Check if current value is usable for the selected profile; if so, keep.
     - Otherwise prompt. For `secret: true` fields, offer "Generate now? [Y/n]". On yes, call `crypto.randomBytes(N).toString("hex")` where `N` comes from the field's declared byte length (default 32).
     - Quote the value with dotenv-escape (SEC-2).
  6. Build in-memory env object; call `envSchema.safeParse(obj)` (refined version, not `envObject`).
  7. On failure: re-prompt only failing fields (max 5 attempts). Error messages NEVER include the rejected value (NF-4.3).
  8. Write via atomic procedure (F-Req-3.5).
  9. Print counts summary (no secrets): `wrote .env.local: 18 vars (3 generated, 2 from profile defaults, 13 user-entered).`

### D. Drift checker

- **Location**: `scripts/check-env-docs.ts` (tsx) + `scripts/env-allowlist.ts` (pure data + type).
- **YAML parser**: if `js-yaml` is present in `package.json` deps or devDeps, use it; else use the in-repo limited-subset parser at `scripts/lib/compose-env-scan.ts` (new file). The in-repo scanner MUST handle `services.*.environment` in both list form (`- VAR=value`, `- VAR=${VAR:?msg}`, `- VAR=${VAR:-default}`, `- VAR=${VAR}`) and map form (`VAR: value`). Document the limitation: if a service's `environment` uses YAML anchors or complex types, the scanner reports `unsupported form` and fails closed.
- **Checks (all exit 1 on any failure)**:
  1. **Zod vs .env.example**: every Zod key appears as either `KEY=...` or `# KEY=...` in `.env.example`. Key missing → report.
  2. **.env.example vs Zod**: every key in `.env.example` is in Zod or allowlist. Extra key → report.
  3. **Compose vs (Zod ∪ allowlist)**: every var referenced in any `docker-compose*.yml` (ANY form — see §D YAML parser spec) is in Zod or allowlist. Missing → report.
  4. **Allowlist dead entry**: each allowlist key is NOT in Zod. If both → report (ambiguous bucket).
  5. **Allowlist stale entry**: each allowlist entry's `consumers[]` paths are opened and grep'd for the allowlist key name; at least one consumer file must contain a match OR the key must appear in at least one `docker-compose*.yml`. Path globs in `consumers[]` are the **literal paths** (F28) — `next.config.ts`, `scripts/*.sh`, `infra/**` are all valid. Missing all references → report stale.
  6. **Sidecar-Zod sync (runtime)**: every Zod key has a sidecar entry, and every sidecar key is in Zod. Also (T27): every sidecar `group` value is in the declared `GROUPS` `as const` list — runtime check closes the TS `as` cast bypass.
  7. **Duplicates**: `.env.example` has no duplicate `KEY=` lines.
  8. **Commented-required**: a key declared as `.required()` in Zod must not appear only as `# KEY=` in `.env.example` (it must be uncommented, even if empty). Note: conditional requirements encoded in `superRefine` (e.g. "SHARE_MASTER_KEY_Vk required iff CURRENT_VERSION=k") are OUT OF SCOPE for this check (F23 documented limitation).
  9. **Allowlist app-read violation (SEC-3)**: no **literal-key** allowlist entry appears as `process.env.X` (bracket-form or dot-form) in `src/**/*.ts` (excluding `**/*.test.{ts,tsx}` and `**/*.test.mjs`). **Regex-form allowlist entries are EXEMPT from this check (F26)** — their purpose is precisely to document an allowed app-read pattern; the rule would otherwise contradict itself. The scanner reports the violation with the reader file:line. Additional scanner coverage (F27): also match `envInt("VARNAME", ...)` and `envBool("VARNAME", ...)` helper calls — the VARNAME string literal is treated as equivalent to `process.env.VARNAME`. `next.config.ts` and other non-`src/` config files are NOT scanned by rule 9 because their env reads are scoped to Next-CLI-time (documented exception; if the same var is also read by runtime code, `src/**/*.ts` scanning catches it).
  10. **Allowlist entry shape**: `justification` matches `/^.{40,}$/`; `consumers` is non-empty; `reviewedAt` parses as ISO-8601. For regex-form entries, the `pattern` string must additionally pass a **bounded-regex safety check (S24, S25)**:
      - No unbounded `.*`, `.+`, `\w*`, `\w+`, `[^]*`, `[^]+`, or equivalent unbounded quantifiers.
      - Pattern must contain a literal prefix of ≥8 non-metacharacter chars before the first quantifier (e.g. `^SHARE_MASTER_KEY_V` is an 8+ char anchored prefix).
      - Pattern must not contain nested quantifiers (catastrophic-backtracking ReDoS risk). Simple structural check: `/[\+\*\{][^\)]*[\+\*\{]/` inside a capture group is rejected.
      - The compiled regex is test-run against a fixed 60-entry fixture of known var names (`AUTH_SECRET`, `DATABASE_URL`, etc.). If the regex matches `>20%` of fixture entries, reject as "overly permissive allowlist pattern".
  11. **Allowlist file presence (S23)**: `scripts/env-allowlist.ts` MUST exist on disk. If absent, report error; prevents a future PR from silently deleting the file while leaving the roster entry behind.
- **`npm script`**: `"check:env-docs": "tsx scripts/check-env-docs.ts"`.
- **CI wiring**: exact block added to `.github/workflows/ci.yml`:
  ```yaml
  env-drift-check:
    name: env drift check
    needs: changes
    if: needs.changes.outputs.env == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npm run check:env-docs
  ```
  And the `changes` job's filter block gains:
  ```yaml
  env:
    - '.env.example'
    - 'src/lib/env.ts'
    - 'scripts/env-descriptions.ts'
    - 'scripts/check-env-docs.ts'
    - 'scripts/env-allowlist.ts'
    - 'scripts/lib/compose-env-scan.ts'
    - 'scripts/generate-env-example.ts'
    - 'docker-compose.yml'
    - 'docker-compose.override.yml'
    - 'docker-compose.ha.yml'
    - 'docker-compose.logging.yml'
  ```
- **`pre-pr.sh` wiring**: insert AFTER the lint step, BEFORE the vitest step (fast-fail per T7). Exit code propagation verified by plan step 11.

### E. Tests (placed at `scripts/__tests__/*.test.mjs` per T1)

**Common obligations for every new test file (T16 + T24)**: Every test file that touches `process.env` either directly or via `spawnSync` MUST:
1. Snapshot the env in `beforeEach` (`const origEnv = { ...process.env }`) and restore in `afterEach` by clearing added keys and re-assigning originals:
   ```ts
   afterEach(() => {
     for (const k of Object.keys(process.env)) if (!(k in origEnv)) delete process.env[k];
     for (const [k, v] of Object.entries(origEnv)) process.env[k] = v!;
   });
   ```
   (T24: plain `process.env = origEnv` reassignment works on Node ≥22 but subprocess spawns that inherit the native env table MAY see the pre-reassignment state; the delete+restore pattern guarantees both JS and native are in sync.)
2. When spawning subprocesses, pass `env: { PATH: process.env.PATH, ...overrides }` **explicitly** — do NOT inherit parent env. This defeats the `src/__tests__/setup.ts:19-28` bleed (T16) AND the Node native-env-table caveat above (T24).
3. Treat any `process.env.X = value` in test code as a bug unless wrapped in before/after restoration.

**Common obligations for platform-gated assertions (T20)**: Use `it.skip(name, reason)` / `describe.skip(...)` with the reason visible in reporter output. **Never** use inline `if (!win32)` branches — they silently no-op.

- `scripts/__tests__/generate-env-example.test.mjs`:
  - "returns exit 0 and matches the snapshot when sidecar+schema are unchanged"
  - "produces byte-identical output across two consecutive runs (determinism)"
  - "sort function is deterministic under the `tr` locale" (T26 redesign — T19's `LC_ALL=tr_TR.UTF-8` approach fails on default `ubuntu-latest` images which do NOT ship this locale). Replacement: unit-level test that feeds a known collation foot-gun sample (`["İ", "I", "i"]`) through the generator's sort function with an explicit locale tag argument, e.g. `new Intl.Collator("tr", { sensitivity: "variant" }).compare`. The generator MUST accept a locale parameter and default to `"en"`; the test asserts the `"en"`-locale output matches the committed snapshot, AND asserts the `"tr"`-locale output also produces a valid (different but deterministic) ordering with no errors. This exercises the foot-gun code path without any OS-locale dependency, making the test runnable on every CI runner and cannot silently skip.
  - "aborts with a secret-pattern error when a non-secret sidecar field carries a value matching `/^[A-Fa-f0-9]{32,}$/`" (S10)
  - "emits zero 32+ hex matches in the generated `.env.example`" (S16 NF-4.6 scope check)
- `scripts/__tests__/check-env-docs.test.mjs`:
  - **Positive**: "returns exit 0 when .env.example is in sync with schema and allowlist"
  - **Negative (seven cases)**:
    1. "reports extra key and exits 1 when .env.example has a key absent from schema"
    2. "reports missing key and exits 1 when schema declares a key absent from .env.example"
    3. "reports undocumented key and exits 1 when docker-compose requires a var with no allowlist or schema entry"
    4. "reports ambiguous-bucket and exits 1 when an allowlist entry is also declared in Zod"
    5. "reports stale-entry and exits 1 when an allowlist key is not referenced by compose or consumers[]"
    6. "reports missing-sidecar and exits 1 when Zod declares a key absent from sidecar"
    7. "reports duplicate and exits 1 when .env.example has two `DATABASE_URL=` lines"
  - Fixtures enumerated (T28) — each case has its own subdirectory under `scripts/__tests__/fixtures/env-drift/`:
    ```
    fixtures/env-drift/
      extra-key/         .env.example, env.ts, env-allowlist.ts, env-descriptions.ts   (case 1)
      missing-key/       .env.example, env.ts, env-allowlist.ts, env-descriptions.ts   (case 2)
      compose-missing/   .env.example, env.ts, env-allowlist.ts, env-descriptions.ts,
                         docker-compose.yml                                              (case 3)
      ambiguous-bucket/  env.ts, env-allowlist.ts, env-descriptions.ts                  (case 4)
      stale-allowlist/   env.ts, env-allowlist.ts, env-descriptions.ts, docker-compose.yml (case 5)
      missing-sidecar/   env.ts, env-allowlist.ts, env-descriptions.ts                  (case 6)
      duplicate-key/     .env.example, env.ts, env-allowlist.ts, env-descriptions.ts    (case 7)
      positive/          full in-sync snapshot used by the positive case test
    ```
    Each fixture contains the minimum files needed to trigger its case; the drift-checker `run()` helper accepts a `rootDir` parameter so tests pass the fixture path.
  - Each test uses `envObject.safeParse({...})` with explicit objects (F16: use base object for tests — the refined schema's superRefine runs cross-field checks that most per-field tests don't care about); does NOT depend on `process.env` (T13).
- `scripts/__tests__/init-env.test.mjs`:
  - "writes a valid .env.local under the dev profile and exits 0"
    - assertions: exit=0; **POSIX-only** `it("sets mode 0600", ...)` block uses `statSync(file).mode & 0o777 === 0o600`; Windows variant uses `it.skip("mode not applicable on win32")` with visible reason (T20); `envSchema.safeParse(parsed).success === true`; generated secrets match `/^[0-9a-f]{64}$/`; captured stderr+stdout does not contain the generated secret literal
  - "reprompts up to 5 times and then exits 1 when production profile receives invalid input"
    - assertions: exit=1; re-prompt count = 5 in transcript; final error references the path, not the value (NF-4.3)
  - "aborts without modification when the user rejects overwriting an existing .env.local"
  - Uses `new PassThrough()` for stdin/stdout/stderr.
- `scripts/__tests__/audit-outbox-worker-env.test.mjs` (T9 Option a + T17 + T21):
  - Pattern: `spawnSync("npx", ["tsx", "scripts/audit-outbox-worker.ts", "--validate-env-only"], { env: { PATH: process.env.PATH, DATABASE_URL: "..." }, timeout: 5000 })`
  - T25: assertions pin the EXACT stdout payload, not substring — e.g., `expect(JSON.parse(stdout.trim())).toEqual({ level: "info", msg: "env validation passed" })`. Substring-only assertions are forbidden because they allow payload drift.
  - Scope note (T29): this file verifies the worker's spawn-contract (exit codes, flag handling, stderr routing, atomic env validation). Exhaustive per-field Zod reject coverage lives in `src/lib/env.test.ts`; the worker test does NOT duplicate per-field checks for all 19 picked keys — it samples (OUTBOX_WORKER_DATABASE_URL URL shape, DATABASE_URL presence, OUTBOX_BATCH_SIZE numeric coercion) as smoke.
  - Cases:
    - "worker exits 1 with stderr JSON `{level:'error',msg:'env validation failed',path:'OUTBOX_WORKER_DATABASE_URL',code:...}` when OUTBOX_WORKER_DATABASE_URL is a malformed URL" (F30)
    - "worker exits 0 and stdout equals `{level:'info',msg:'env validation passed'}` when OUTBOX_WORKER_DATABASE_URL is unset and DATABASE_URL is a valid URL" (T21 — automates NF-6 step 4's manual fallback check)
    - "worker exits 1 with clear error when DATABASE_URL is missing entirely"
    - "worker exits 1 with clear error when OUTBOX_BATCH_SIZE is non-numeric"
    - "stderr from failure path does NOT include the rejected value" (F30 + S22 — regression)
- `scripts/__tests__/pre-pr-env-drift.test.mjs` (T7 + T18):
  - T18: do NOT spawn full `pre-pr.sh` (it would recursively invoke vitest). Instead:
    1. "`npm run check:env-docs` exits 1 when sidecar is broken" — spawn ONLY that npm script with fixture.
    2. "`scripts/pre-pr.sh` contains the check:env-docs wiring" — grep assertion: `expect(readFileSync('scripts/pre-pr.sh', 'utf8')).toMatch(/run_step\s+".*env drift.*"\s+.*check:env-docs/)`. This proves the step is wired without executing the orchestrator.
- `scripts/__tests__/pre-pr-hex-fallback.test.mjs` (S14):
  - Three synthetic staged diffs as fixtures:
    (a) hex in dotenv line → fallback exits 1
    (b) hex in `.ts` string literal → fallback exits 1
    (c) hex in a Markdown comment / code-block → fallback exits 0 (not a leak)
  - Verifies the SEC-5 fallback shell snippet behaves as specified.
- `scripts/__tests__/check-env-gitignore.test.mjs` (SEC-1):
  - iterates [".env.local.tmp", ".env.local.tmp.123", ".env.local.bak", ".env.local.bak-20260424-120000", ".env.local.bak.foo"], asserts `git check-ignore` exits 0 for each.
- `src/lib/env.test.ts` (canonical schema tests per F12):
  - Extends the current test file. Adds per-field accept/reject tests for A1-A33 (A34 moved to allowlist) + V1..V10. Uses the newly-exported `envObject` directly (`envObject.safeParse({...})`), avoiding the `parseEnv()` side-effect (T2 + F16).
  - Specific regression test (F22): "rejects when SMTP_PORT is empty string" — proves the documented boot tightening.
  - `src/__tests__/env.test.ts` is kept for boot/side-effect tests; a top-of-file docstring clarifies the split.

---

## Implementation steps

1. **Prerequisites**
   - `git checkout main && git pull`
   - `git checkout -b feature/env-config-sync-and-generator`
   - Run `npm run check:env-docs` baseline on current `main` (script not yet present — record: "baseline unavailable, current drift unmeasured").
   - `node -e "const pkg = require('./package.json'); console.log({jsYamlPresent: !!(pkg.dependencies && pkg.dependencies['js-yaml']) || !!(pkg.devDependencies && pkg.devDependencies['js-yaml'])})"` → record result in deviation log. Determines whether to use js-yaml or the in-repo scanner.
   - Confirm `.github/CODEOWNERS` exists (already verified: yes).

2. **SEC-1 gitignore** (first commit)
   - Add the five gitignore lines.
   - Add `scripts/__tests__/check-env-gitignore.test.mjs`.
   - Run the test; confirm it passes.
   - Rationale: land this BEFORE any generator code exists so an in-flight generator can never leak secrets.

3. **Zod schema export and decomposition** (T2 + **F16 Critical**)
   - Edit `src/lib/env.ts` to split the refined schema from the pickable base:
     ```ts
     // Base object — pickable, iterable (.shape), no refinements. Used by tests
     // and the worker's envObject.pick({...}). Export as a named export.
     export const envObject = z.object({ ... });

     // Refined variant — adds superRefine for cross-field checks. Used by
     // parseEnv() at server boot.
     export const envSchema = envObject.superRefine((data, ctx) => { ... });

     // Helper used by the drift checker — uniform access regardless of wrapper.
     export const getSchemaShape = () => envObject.shape;
     ```
   - Required because Zod 4.3.6 throws `.pick() cannot be used on object schemas containing refinements` when called on a `ZodEffects` produced by `.superRefine()` (F16 evidence). The worker (step 5) and drift checker (T23) depend on `.pick()`/`.shape` being available.
   - Confirm existing `src/__tests__/env.test.ts` still passes; any test that imports `envSchema` continues to receive the refined schema.

4. **Zod completeness** (A1-A33 + V1-V10 split — A34 moved to allowlist per F19)
   - Group into 4 commits to keep review tractable:
     - **Commit 4a**: A1-A9 (logger, health, auth/email fields) including `superRefine` additions for EMAIL_PROVIDER-conditional SMTP_HOST/RESEND_API_KEY/EMAIL_FROM.
     - **Commit 4b**: A10-A14 (cloud providers, Tailscale, Sentry).
     - **Commit 4c**: A15-A19 (Redis Sentinel) + A20-A29 (OUTBOX_*).
     - **Commit 4d**: A30-A34 (NEXT_PUBLIC_* + NEXT_DEV_ALLOWED_ORIGINS) + D6-split (SHARE_MASTER_KEY_V1..V10 explicit fields, remove `process.env[...]` bracket reads from superRefine).
   - For each commit:
     - Trace every `process.env.<VAR>` call site in `src/` and verify the Zod default matches the call-site default. Fix any divergence in the SAME commit.
     - Update `src/__tests__/env.test.ts` (boot/side-effect coverage, uses refined `envSchema`) AND add the per-field test in `src/lib/env.test.ts` using the exported base `envObject.safeParse({...})` (F16 discipline: per-field tests avoid refinement cross-talk).
     - Run `npm run dev` briefly after each commit to ensure boot is clean with an unchanged `.env.local`.

5. **Worker env validation** (T9 Option a + F16 fix + F21 + T17)
   - Edit `scripts/audit-outbox-worker.ts`:
     ```ts
     import { envObject } from "@/lib/env";

     const workerEnvSchema = envObject.pick({
       DATABASE_URL: true,
       OUTBOX_WORKER_DATABASE_URL: true,
       OUTBOX_BATCH_SIZE: true,
       OUTBOX_POLL_INTERVAL_MS: true,
       OUTBOX_PROCESSING_TIMEOUT_MS: true,
       OUTBOX_MAX_ATTEMPTS: true,
       OUTBOX_RETENTION_HOURS: true,
       OUTBOX_FAILED_RETENTION_DAYS: true,
       OUTBOX_READY_PENDING_THRESHOLD: true,
       OUTBOX_READY_OLDEST_THRESHOLD_SECS: true,
       OUTBOX_REAPER_INTERVAL_MS: true,
       NODE_ENV: true,
       DB_POOL_MAX: true,
       DB_POOL_CONNECTION_TIMEOUT_MS: true,
       DB_POOL_IDLE_TIMEOUT_MS: true,
       DB_POOL_MAX_LIFETIME_SECONDS: true,
       DB_POOL_STATEMENT_TIMEOUT_MS: true,
       LOG_LEVEL: true,
       AUDIT_LOG_FORWARD: true,
       AUDIT_LOG_APP_NAME: true,
     });
     const result = workerEnvSchema.safeParse(process.env);
     if (!result.success) {
       // F30 + S22: never echo rejected value. Emit path + code only.
       for (const issue of result.error.issues) {
         console.error(JSON.stringify({
           level: "error",
           msg: "env validation failed",
           path: issue.path.join("."),
           code: issue.code,
         }));
       }
       process.exit(1);
     }
     const workerEnv = result.data;

     // --validate-env-only flag (T17). Exact stdout contract for test assertion.
     if (process.argv.includes("--validate-env-only")) {
       console.log(JSON.stringify({ level: "info", msg: "env validation passed" }));
       process.exit(0);
     }

     const databaseUrl = workerEnv.OUTBOX_WORKER_DATABASE_URL ?? workerEnv.DATABASE_URL;
     // ... rest of startup
     ```
   - F21 resolution: the `pick` set is enumerated explicitly (no `...`), covering every OUTBOX_* plus the pool / logging vars the worker reads transitively via imported modules. Caveat: `src/lib/constants/audit/audit.ts:680-688` still uses `envInt()` at module-load time (Phase 2 migration target); validation duplicates the envInt defaults but surfaces malformed values earlier.
   - T17 resolution: `--validate-env-only` flag makes the env-validation path unit-testable without needing a real Postgres connection. Test (§E) spawns this with explicit env.
   - F30 + S22 resolution: `safeParse` + per-issue sanitized error (no `issue.received`, no `issue.message`) prevents Zod from leaking rejected values (e.g. partial `DATABASE_URL` containing password) to stderr/CI logs.

6. **Sidecar descriptions** (`scripts/env-descriptions.ts`)
   - Author descriptions for every current + A1-A34 + V1-V10 key.
   - `Record<keyof z.infer<typeof envObject>, SidecarEntry>` TypeScript constraint (uses `envObject`, not `envSchema` — F16/F31).
   - Mark `secret: true` on: SHARE_MASTER_KEY, SHARE_MASTER_KEY_V1..V10, VERIFIER_PEPPER_KEY, ADMIN_API_TOKEN, AUTH_SECRET, AUTH_GOOGLE_SECRET, AUTH_JACKSON_SECRET, WEBAUTHN_PRF_SECRET, DIRECTORY_SYNC_MASTER_KEY, RESEND_API_KEY, SMTP_PASS, SENTRY_DSN, REDIS_SENTINEL_PASSWORD, AZURE_STORAGE_CONNECTION_STRING, AZURE_STORAGE_SAS_TOKEN.

7. **Generator** (`scripts/generate-env-example.ts`)
   - Implement per §B.
   - `npm script`: `"generate:env-example"`.
   - Regenerate `.env.example`. Commit with the sidecar so the diff is auditable.

8. **Drift checker + allowlist + governance**
   - Author `scripts/env-allowlist.ts` with A-Table-2 entries + the AllowlistEntry type (literal + regex forms).
   - Author `scripts/check-env-docs.ts` per §D. If `js-yaml` absent, author `scripts/lib/compose-env-scan.ts` with the limited-subset parser.
   - Add CI job + changes filter per §D.
   - Add `check:env-docs` to `scripts/pre-pr.sh` after the lint step (T18: ordering — before `vitest`/`build` for fast-fail).
   - Add CODEOWNERS line per SEC-4 **AND** add `"scripts/env-allowlist.ts"` to `scripts/check-codeowners-drift.mjs` ROSTER_GLOBS (S18) — single commit.
   - SEC-5 gitleaks fallback (broadened per S14) in `pre-pr.sh`.
   - Add `scripts/__tests__/pre-pr-hex-fallback.test.mjs` (S14) with three synthetic staged-diff fixtures.

9. **Interactive generator** (`scripts/init-env.ts` + `scripts/lib/prompt.ts`)
   - Implement `run(opts)` API per §C.
   - `npm script`: `"init:env"`.

10. **Tests** (§E)
    - All six test files listed. Place under `scripts/__tests__/` with `.mjs` extension (T1).
    - Verify each is picked up by `vitest run` (grep the reporter output for each test file path).

11. **Pre-PR smoke**
    - Run `scripts/pre-pr.sh` in its entirety — it must pass.
    - Verify check:env-docs exit-code propagation: manually break the sidecar (delete one entry), re-run pre-pr.sh, assert non-zero exit. Revert.

12. **Documentation**
    - `README.md`: "Configure environment" section → replace hand-written table note with `npm run init:env`. The table itself may stay as an overview but is no longer authoritative.
    - `CLAUDE.md`: Common Commands → add `init:env`, `generate:env-example`, `check:env-docs`.

13. **NF-6 boot verification** (mandatory gate before PR)
    - All four steps executed and recorded.

14. **Commit review-file updates**
    - Final state of `docs/archive/review/env-config-sync-and-generator-review.md` with all rounds' deduplicated findings.

---

## Testing strategy

- **Unit (vitest, `src/lib/env.test.ts`)**: per-field accept/reject for A1-A33 + V1-V10 via the exported base `envObject.safeParse({...})` (F16 + F25) — no module reset, no side effects, no refinement cross-talk.
- **Regression (`src/__tests__/env.test.ts`)**: boot-level parseEnv tests stay; docstring clarifies the split with the canonical file.
- **Snapshot (generate-env-example)**: stable across runs and locales.
- **Drift-checker**: 1 positive + 7 negative cases.
- **Interactive generator**: 3 scripted-stdin flows.
- **Worker env**: 2 scenarios (valid fallback, invalid URL).
- **pre-pr.sh integration**: non-zero exit propagation.
- **Gitignore**: `git check-ignore` per generated-file pattern.
- **NF-6 boot verification** (manual, pre-PR): dev/build/start/worker.
- **CI**: new `env-drift-check` job on every PR touching the env surface.

---

## Considerations & constraints

### Risks and mitigations

- **R-1 Over-tightening**: mitigated by §A-Table-1's "Keep current runtime default" discipline + NF-5 explicit anti-regressions.
- **R-2 Drift-checker false positives**: mitigated by A-Table-2 allowlist and the `consumers[]` field.
- **R-3 Memory-rule compliance**: branch = `feature/env-config-sync-and-generator` (English only); plan path = `docs/archive/review/…`; pull latest before branching (step 1).
- **R-4 Secret exposure paths**: SEC-1 (gitignore), NF-4 (transcript/mode/backup), SEC-2 (stdin escape), SEC-5 (gitleaks fallback).
- **R-5 Non-POSIX platforms**: NF-4.4 warning; backup/write best-effort on Windows.
- **R-6 Multi-source defaults**: step 4's "trace every process.env call site" obligation.
- **R-7 CODEOWNERS stale review**: plan adds exactly one line (`scripts/env-allowlist.ts`) alongside the allowlist file creation commit; reviewer is the same as existing lines (@ngc-shj).
- **R-8 js-yaml decision reversal**: plan commits to a single decision at step 1 and records it. The in-repo scanner (if chosen) is ≤150 LoC with its own test.

### Out of scope

- CLI package config (`cli/.passwd-sso-env.example.json`) — JSON format, XDG-dir storage. Follow-up: extend the sidecar/generator to cover it.
- Extension package env — build-time Vite config only.
- Migration of `process.env.X` call sites to `import { env }` — Phase 2 per existing `env.ts` header.
- `--non-interactive` / `--edit` / `--input=file.json` generator modes — reserved flag names that error with "Not implemented in this PR".
- SHARE_MASTER_KEY versions >10 — follow-up PR; current max is 100 per CURRENT_VERSION schema. Tightened to 10 in this PR; if keys 11+ are ever rotated, that PR must revisit this cap AND add new Zod fields AND extend the generator's V-key prompt loop.
- Prometheus/Grafana env (`docker-compose.logging.yml`) — delegated to overlay-owner; drift checker still scans the file for key names (reported as allowlist entries if not Zod).

---

## User operation scenarios

### Scenario 1: New developer onboarding
1. Clones repo, `npm install`, `npm run init:env`.
2. Picks `dev` profile. Hex64 secrets offered as "Generate now? [Y/n]".
3. File written with `0o600`; summary shows counts, not values.
4. `docker compose up` and `npm run dev` succeed on first try.

### Scenario 2: Production rotation preparation
1. Operator runs `npm run init:env --profile=production`.
2. Generator prompts for provider IDs, SMTP credentials, existing master keys (paste).
3. On invalid hex, re-prompts with `path + message`; never shows the rejected value.
4. After ≤5 attempts per field, exits 0 with `.env.local` ready, OR exits 1 with a clear `path` listing fields still missing.

### Scenario 3: Dev adds a new env var
1. Adds `FOO_BAR` to Zod.
2. Forgets the sidecar entry.
3. `tsc` flags `Record<keyof Env, SidecarEntry>` mismatch.
4. After updating the sidecar, `npm run generate:env-example` emits an updated `.env.example`.
5. `npm run check:env-docs` passes; CI passes.

### Scenario 4: Stale allowlist audit
1. A `scripts/env-allowlist.ts` entry for `OLD_VAR` exists but no compose file references it and no `consumers[]` path matches.
2. `npm run check:env-docs` fails with "stale allowlist: OLD_VAR — no compose reference, no consumer file match".
3. PR must either remove the entry or update `consumers[]` with the current path.

### Scenario 5: Preserving existing `.env.local`
1. Run `npm run init:env`.
2. Prompt: `[Overwrite / Backup-and-overwrite / Abort]`.
3. Pick Backup → `.env.local.bak-20260424-UTC-083000` created (mode 0o600; gitignored).
4. New file written atomically.

### Edge cases verified during implementation

- Blank `process.env`: generator completes with all `dev` defaults.
- ANSI-unaware terminals: generator detects `process.stdout.isTTY === false` and outputs plain text.
- `.env.local` has an extra key not in schema: drift-checker flags; generator preserves only if user opts in at prompt time.
- Windows (non-WSL): warning printed; write still attempted with `fs.open('wx', 0o600)` (mode ignored on Windows).
- `umask 0` CI runners: the `fs.open('wx', 0o600)` creation mode is preserved; unit test `process.umask(0)` confirms.

---

## Implementation Checklist (Phase 2 Step 2-1)

### Files to create (new)
- `scripts/env-descriptions.ts` — sidecar (GROUPS, SidecarEntry, descriptions record)
- `scripts/env-allowlist.ts` — literal + regex allowlist
- `scripts/generate-env-example.ts` — `.env.example` generator
- `scripts/check-env-docs.ts` — drift checker (11 rules)
- `scripts/init-env.ts` — interactive generator
- `scripts/lib/prompt.ts` — readline/promises wrapper
- `scripts/lib/compose-env-scan.ts` — docker-compose YAML limited-subset parser
- `scripts/lib/hex-leak-scan.mjs` — Node-based gitleaks fallback
- `scripts/__tests__/generate-env-example.test.mjs`
- `scripts/__tests__/check-env-docs.test.mjs`
- `scripts/__tests__/init-env.test.mjs`
- `scripts/__tests__/audit-outbox-worker-env.test.mjs`
- `scripts/__tests__/pre-pr-env-drift.test.mjs`
- `scripts/__tests__/pre-pr-hex-fallback.test.mjs`
- `scripts/__tests__/check-env-gitignore.test.mjs`
- 8 fixture subdirectories under `scripts/__tests__/fixtures/env-drift/`

### Files to modify
- `.gitignore` — add 5 lines (SEC-1)
- `.github/CODEOWNERS` — add 1 line for scripts/env-allowlist.ts (SEC-4)
- `scripts/check-codeowners-drift.mjs` — add "scripts/env-allowlist.ts" to ROSTER_GLOBS (S18)
- `src/lib/env.ts` — split `envObject`/`envSchema`, add A1-A33 + V1-V10, remove SMTP_HOST escape hatch
- `src/lib/env.test.ts` — NEW file (or extend); per-field tests using `envObject.safeParse`
- `src/__tests__/env.test.ts` — keep as boot/superRefine coverage; top docstring clarifies split
- `src/lib/env/env-utils.ts` — UNCHANGED (envInt helper stays; drift checker scans for it)
- `scripts/audit-outbox-worker.ts` — add envObject.pick + --validate-env-only flag
- `scripts/pre-pr.sh` — add check:env-docs step + Node-based gitleaks fallback
- `.github/workflows/ci.yml` — add env-drift-check job + changes.env filter
- `package.json` — add scripts: `init:env`, `generate:env-example`, `check:env-docs`
- `.env.example` — regenerated from sidecar + schema
- `README.md` — "Configure environment" section points to `npm run init:env`
- `CLAUDE.md` — Common Commands block gets 3 new scripts

### Shared utilities to REUSE (R1 discipline)
- `src/lib/env/env-utils.ts::envInt` — used by audit.ts OUTBOX_* reads (keep as-is; drift check 9 scans these)
- `npm run generate:key` (existing npm script) — referenced in `.env.example` placeholder (S21)
- `scripts/__tests__/check-licenses.test.mjs` `run()` helper pattern — reuse for drift-checker tests
- `scripts/__tests__/move-and-rewrite-imports.test.mjs` `execFileSync`/`spawnSync` pattern — reuse for worker + pre-pr tests
- Existing `scripts/checks/check-codeowners-drift.mjs` — extend ROSTER_GLOBS, don't duplicate the check
- `dotenv@^17.2.4` (existing dep) — for quoting/escaping values in the generator
- `src/lib/load-env.ts` (existing wrapper for dotenv) — worker already imports via `loadEnv()`

### Dependencies NOT to introduce
- `@clack/prompts` (even transitive) — use `node:readline/promises` only
- `js-yaml` — use in-repo `compose-env-scan.ts` (package.json confirms not present)
- Any new TUI lib

### Existing constants/defaults that must match Zod additions
| Variable | Current runtime default | Zod action |
|---|---|---|
| HEALTH_REDIS_REQUIRED | `false` (unset → false) | `.default("false")` — NF-5 |
| LOG_LEVEL | `"info"` | `.default("info")` — no superRefine prod ban this PR |
| SMTP_PORT | `587` | `.default(587)` — empty string now rejects (documented) |
| AUDIT_LOG_APP_NAME | `"passwd-sso"` | already `.default("passwd-sso")` |
| OUTBOX_BATCH_SIZE..OUTBOX_REAPER_INTERVAL_MS | values in `src/lib/constants/audit/audit.ts:680-688` | match envInt defaults exactly |
| SHARE_MASTER_KEY_CURRENT_VERSION | `.max(100)` | unchanged (NF-5 F17) |
| NEXT_PUBLIC_* | consumer `??` fallbacks | server-side `.default()` added; consumer fallbacks kept (F20) |

### Storage-backend schema verification
N/A — no DB migrations, no raw-query tests.

---

## Open questions (all resolved through Round 2)

1. ~~README.md env table sync~~ → NOT in scope; README table becomes descriptive, not authoritative. Generator's `.env.example` is the source of truth.
2. ~~PASSWD_OUTBOX_WORKER_PASSWORD bucket~~ → allowlist (A-Table-2).
3. ~~@clack/prompts~~ → forbidden. NF-1 + S11.
4. ~~--non-interactive / --edit~~ → reserved, errors in this PR; out of scope.
5. ~~JACKSON_API_KEY bucket~~ → allowlist only (F5 / T14 resolved).
6. ~~LOG_LEVEL classification~~ → add to Zod (F3 / T15 resolved). **Production debug/trace ban DEFERRED** to a follow-up PR (S15 / NF-5).
7. ~~HEALTH_REDIS_REQUIRED default~~ → `false` (S3 / T8 resolved).
8. ~~SHARE_MASTER_KEY_V{N} SSOT status~~ → hybrid: V1..V10 explicit Zod fields; V11..V100 documented allowlist-regex exception; CURRENT_VERSION.max stays 100 (S4 / F13 / F17 resolved).
9. ~~Worker env validation~~ → Option (a) via `envObject.pick()` on the BASE object (not the refined schema) (T9 / F16 resolved). Worker gains `--validate-env-only` flag for unit testing (T17).
10. ~~NEXT_DEV_ALLOWED_ORIGINS bucket~~ → allowlist only; reader (`next.config.ts`) runs before Zod validation (F19 resolved).
11. ~~NEXT_PUBLIC_* Zod default vs client inline~~ → server-side Zod default as safety net; consumer-side `??` fallbacks preserved in NF-5 (F20 resolved).
12. ~~CODEOWNERS self-healing~~ → add roster entry to `check-codeowners-drift.mjs` (S18 resolved).
13. ~~SEC-5 fallback scope~~ → broadened to `\b[a-f0-9]{64}\b` with comment-line exclusion (S14 resolved).
14. ~~Determinism locale test~~ → use `tr_TR.UTF-8` (always available on ubuntu-latest) with precondition skip (T19 resolved).
15. ~~pre-pr.sh test recursion risk~~ → split into (a) check:env-docs direct test, (b) grep wiring assertion (T18 resolved).
