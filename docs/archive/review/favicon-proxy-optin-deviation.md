# Coding Deviation Log: favicon-proxy-optin

## D1 — Dev-DB migration checksum drift (non-destructive repair)
- **What**: `npm run db:migrate` refused to run, reporting drift on the unrelated, pre-existing migration `20260618000000_add_retention_gc_worker_role` ("modified after it was applied"). `prisma migrate status` reported the schema fully up to date — the drift was purely a checksum mismatch in the dev DB's `_prisma_migrations` row (recorded `ab16...` vs current-file `a3c6...`), a dev-scratch artifact unrelated to this branch (file matches main exactly).
- **Why deviation**: the plan assumed a clean `db:migrate`. The only path Prisma's `migrate dev` offered was `migrate reset` (destructive — wipes the dev DB). Per R31 / `feedback_no_destructive_docker_down_v`, that requires explicit user confirmation.
- **Resolution**: user chose the non-destructive option. Updated the single drifted `_prisma_migrations.checksum` to the current file hash (scoped `WHERE migration_name=... AND checksum=<old>`; 1 row). No schema/data change. Then `db:migrate` generated C1 cleanly.

## D2 — Generated C1 migration contained an unrelated ALTER; removed it
- **What**: the generated `20260623152753_add_user_fetch_favicons/migration.sql` included `ALTER TABLE "audit_chain_anchors" ALTER COLUMN "prev_hash" SET DEFAULT '\x00'::bytea;` in addition to the intended `ALTER TABLE "users" ADD COLUMN "fetch_favicons"...`. The extra line was Prisma reconciling a pre-existing dev-DB divergence from the committed schema (schema line 1144 already declares that default) — not part of this feature.
- **Why deviation**: shipping an unrelated ALTER in a feature migration is poor hygiene and could conflict in other environments.
- **Resolution**: edited the migration file to contain ONLY the `users.fetch_favicons` column. Re-synced the new migration's recorded checksum to the edited file (same non-destructive technique as D1). `migrate status` clean (172 migrations, up to date). The `audit_chain_anchors` default was already applied to the dev DB by the migration run and matches the committed schema, so the dev DB stays correct.

## D3 — Buffer pool-aliasing fix in the proxy response (security-relevant)
- **What**: Batch A's route returned `cached.body.buffer as ArrayBuffer`. `Buffer.from(base64)` (the Redis cache path) returns a view onto Node's shared 64 KB pool (`buffer.byteLength=65536`, `byteOffset>0`), so `body.buffer` would have sent the ENTIRE pool — including other requests' bytes — past the favicon (info leak + corruption). Unit tests missed it because the mock returns a fresh `Response` (non-pooled path).
- **Why deviation**: not in the plan; discovered during R21 production-code spot-check.
- **Resolution**: introduced `faviconResponse()` that copies exactly `byteLength` bytes via `Uint8Array.from(body)`. Added a fail-red regression test (`route.test.ts` "returns exact favicon bytes when cache holds a pool-aliased Buffer") that seeds a pool-aliased Buffer and asserts exact length — verified it goes red (`expected 65536 to be 5000`) on the buggy form and green on the fix.

## D4 — Added next-auth/react mock to password-detail-pane.test.tsx (R19 follow-through)
- **What**: `password-detail-pane.test.tsx` renders the REAL `EntryIcon`/`Favicon` (it does not mock the favicon module). After C3 made `Favicon` call `useSession()`, 11 tests failed with "`useSession` must be wrapped in a <SessionProvider />".
- **Why deviation**: the plan's R19 note (T6) enumerated the 4 files that `vi.mock` the favicon module and correctly said they need no change — but this 5th file renders favicon un-mocked and was not in that list.
- **Resolution**: added a `vi.mock("next-auth/react", ...)` returning a resolved favicons-OFF session (the established mock mechanism). Swept all test files: only `favicon.test.tsx` (own mock) and this file render the real favicon; no other file affected.
