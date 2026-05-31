# Coding Deviation Log: personal-history-aad-mismatch

## Part A

### D1 — Migration applied via hand-authored file + `db execute` + `migrate resolve` (not `prisma migrate dev`)
- **Plan**: C8/C10 said generate the enum-recreate migration via `npm run db:migrate`.
- **What happened**: `prisma migrate dev` refused to proceed and demanded a full DB **reset** (destroy all data) because of **pre-existing dev-DB drift** unrelated to this change:
  1. `20260524060000_extension_dpop_sender_constrained` checksum mismatch ("modified after applied") — the committed file (#491) is clean in-tree; the dev DB recorded an older checksum.
  2. `access_requests` FK naming drift (DB has custom-named FKs `_requester_user_fk`/`_requester_sa_fk`; schema.prisma relations generate default names) — pre-existing since `20260522000100_access_request_requester`.
- **Resolution (no reset, per user "resetせずに適切に対処")**: hand-authored the recreate migration `prisma/migrations/20260531030918_remove_entry_history_reencrypt_audit_action/migration.sql` (enum values sourced from schema.prisma; Prisma-convention no explicit BEGIN/COMMIT), applied to the dev DB via `docker compose exec db psql --single-transaction` as `passwd_user`, then recorded it with `prisma migrate resolve --applied`. Verified: 987→987 audit_logs rows (no data loss), enum 170→169, `ENTRY_HISTORY_REENCRYPT` absent, queries on `audit_logs.action` succeed.
- **Why acceptable**: the migration FILE is correct and committed (fresh deploys via `migrate deploy` apply it normally — Prisma wraps it in a transaction). The hand-application only worked around the drift for THIS dev DB. The pre-existing drift is a **separate, out-of-scope** dev-environment issue (surfaced to the user; not introduced or worsened here). Full backup taken before any DB write: `~/passwd-sso-backups/passwd_sso-20260531-103630.sql.gz`.
- **Follow-up (tracked, not this PR)**: `TODO(personal-history-aad-mismatch): reconcile pre-existing dev-DB drift (dpop migration checksum + access_requests FK naming) so plain `prisma migrate dev` works without reset.`

### D2 — Sub-agent (C6–C9) removed additional now-dead symbols beyond the plan's explicit list
- `entry.ts`: also dropped `ENCRYPTED_ITEM_KEY_MAX`, `hexString` imports (orphaned after the two schemas were removed).
- `common.test.ts`: removed the `CIPHERTEXT_MAX < HISTORY_BLOB_MAX` assertion + import (HISTORY_BLOB_MAX deleted).
- `entry.test.ts`: removed orphaned `HEX_HASH` const (lint warning fix).
- `vault-context.test.tsx`: dropped unused `store` destructure in the new C2 guard (lint warning fix).
- **Why acceptable**: all are dead-after-removal cleanups consistent with the "全dead code削除" directive; no behavior change.

### D3 — Added fix (user-requested mid-implementation): personal entry/import keyVersion no longer hardcoded to 1
- **Trigger**: while diagnosing why a user's older LOGIN entries stopped displaying (turned out to be a separate vault key-version mismatch — see below), found that `personal-entry-save.ts:51` and `password-import-importer.ts:165` hardcoded `keyVersion: 1` on every save/import, mis-stamping entries after a key rotation (vault at v3 → new entries wrongly stamped v1). User directed "既存の不具合 ver 1 固定は今回修正します".
- **Fix**: threaded the current vault key version (`useVault().getKeyVersion()`, = the version of the unlocked encryption key the blob is actually encrypted with) through both chains, making `keyVersion` a required param on `savePersonalEntry` / `executePersonalEntrySubmit` (compile-enforced completeness) and a guarded param on the personal import path. 10 production files + 9 test files. `setup/route.ts` (initial v1) and `vault-reset.ts` (v0) left as-is — intentional, not bugs.
- **R21 catch**: the implementing sub-agent ran only the 7 test files it directly touched and reported green; the orchestrator's full-suite re-run surfaced 3 MORE test files (`use-personal-base-form-model.test.ts`, `password-import.test.tsx`, `personal-login-form-folder.test.tsx`) whose `useVault()` mocks lacked `getKeyVersion` → `getKeyVersion is not a function` (R19 mock-alignment). Orchestrator added `getKeyVersion: () => 1` to each. Final: full suite 10,738 pass, build green, lint clean.

### Context note — the LOGIN-entries-not-displaying symptom was NOT caused by this change
- Verified against the pre-work backup: the user's vault credentials (account_salt, encrypted_secret_key, key_version=3) AND all login ciphertext (blob + overview) were **byte-identical** before and after this session's work. The symptom was a pre-existing vault key-version mismatch (408 logins at kv=3 not decrypting with the currently-unlocked key, while 2 kv=1 entries did). The user resolved it by performing a full **vault reset** (their action, via the app) and will re-import. No data was lost or corrupted by this work; the only DB write was the isolated `AuditAction` enum recreate (audit_logs only).
