# Coding Deviation Log: saml-jackson-account-rekey

## D1 — C4: one bypass grant instead of two
- Plan: `TENANT_ACCOUNT_REKEY_READ` (preview) and `TENANT_ACCOUNT_REKEY_APPLY` (apply).
- Implemented: one `BYPASS_GRANT.TENANT_ACCOUNT_REKEY` (`account`, `auditOutbox`, `tenant`, `tenantClaim`, `tenantClaimEvent`, `tenantMember`) for both modes.
- Why: preview and apply run the same transaction body; `scripts/checks/check-bypass-rls.mjs` requires a literal `BYPASS_GRANT.*` member per `withBypassRls` call, so a conditional grant is refused, and the alternative — two call sites over one body — gives the preview a grant whose reach the gate judges against the apply body anyway. The preview path reaches no `auditOutbox` write (it returns before the confirmation); the grant only admits what the database examines.

## D2 — C1 step 10: the CAS `where` / `data` are inline literals
- Plan named `Prisma.AccountWhereInput` / `Prisma.AccountUpdateManyMutationInput` variables.
- Implemented inline in the `updateMany` call: a variable argument is one `check-bypass-rls` cannot read ("unreadable relation argument"), which makes the call's relation reach unknown. The types are the same ones Prisma checks the literal against.

## D3 — Step 2-2: production code written by the orchestrator
- The skill delegates implementation batches to Sonnet sub-agents. The production code (C1/C2/C3/C5/C6/C7) was written directly by the orchestrator: it is one security-critical command whose contracts went through four review rounds, and splitting it across agents would have split the snapshot/re-read/CAS invariants across authors. Test batches (unit, integration) were delegated.

## D4 — (withdrawn) verify pass and the warm report
- First implemented by letting `decryptAccountTokenTriple` alone classify an unloadable version. The integration cell for the plan's contract failed: a version the provider reports unavailable while this process can still read a cached copy passed the preview, and the apply pass would then abort after the prompt. Reverted to the plan: the verify pass reads the warm report and marks each field it encrypts `KEY_UNAVAILABLE`; the decrypt classifier reports every other failure.

## D5 — Red-proofs not executed
- Not red-proven by execution: moving `enqueueAuditInTx` after the transaction (the audit rows' rollback assertions cover the outcome, but the mutation would also move the write past the rollback paths the cells drive, so no cell isolates it); dropping a model from `TENANT_ACCOUNT_REKEY` (proven structurally by `check-bypass-rls`, which fails a grant missing a reached model, and by the RDS-shaped cells, which run under a role RLS binds). `bindingAttestation` / `rekeyClaimCheck` mutations were red-proven by the unit batch (seq order, null skip, label normalisation, operator flag, google branch).
- One surviving mutation: replacing the claim ids in the step-9 key with a constant while keeping the count. Accepted: every step-9 cell that changes the claim set also changes its size or a claim's provider/seq, and an id swapped one-for-one with no other change is a revoke-plus-register, which records events and changes the deciding `seq`.

## D6 — C6 widened to the whole "cold key provider outside the app" class (R42)
- Plan: the warm helper in `scripts/lib/`, applied to `rekey-accounts` and `migrate-account-tokens-to-encrypted.ts`.
- Phase 2 self-check (functionality and testing experts) found a third member, `scripts/migrate-webhook-secrets-v1-to-v2.ts`. The member set was then re-derived from the primitive — every non-app entry point that reaches `getMasterKeyByVersion` / `getKeyProviderSync` (`grep -rlE "getMasterKeyByVersion|getCurrentMasterKeyVersion|account-token-crypto|crypto-server|getKeyProviderSync|getKeySync" scripts src/workers`) — which adds `src/workers/audit-outbox-worker.ts` (its webhook-target config decrypt). Both are fixed: the helper moved to `src/lib/crypto/share-master-keys.ts` so the worker can import it; the webhook migration warms the row versions after each read (an unloadable version fails its rows through the existing per-row skip, exit 1); the worker warms the target's version inside its delivery try, so a failure is recorded as a delivery error.
- Not members: `scripts/regenerate-account-token-legacy-fixture.ts` (dev fixture generator with its own fixed keys) and `scripts/manual-tests/share-access-audit.ts` (manual test).
- Test coverage of the two new call sites: `src/__tests__/db-integration/cloud-key-provider-warm.integration.test.ts` runs `processDeliveryBatch` and `migrateWebhookSecrets` under `KEY_PROVIDER=aws-sm` with a stateful fake provider, over rows encrypted under a non-current key version; both cells were red-proven on scratch copies with the warm calls removed (the delivery is never handed to the deliverer; every row is skipped).

## D5 addendum — Phase 2 self-check RT7
- The testing self-check re-raised D5's unexecuted red-proofs as RT7 Major. Disposition unchanged, with the reasoning made explicit: moving `enqueueAuditInTx` after the transaction makes it run outside `withBypassRls`, where `enqueueAuditInTx` throws ("called outside withBypassRls/withTenantRls scope"), so the allow-path cells (ok + exactly two outbox rows) fail; dropping a model from `TENANT_ACCOUNT_REKEY` fails `check-bypass-rls` (a reached model outside the grant) and the RDS-shaped cells (RLS refuses the ungranted table). Both are decided by an adjudicator that runs in CI, not by a test the mutation could leave green.
