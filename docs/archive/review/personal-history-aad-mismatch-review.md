# Plan Review: personal-history-aad-mismatch
Date: 2026-05-31
Review round: 1 (3 expert sub-agents: Functionality / Security / Testing)

## Changes from Previous Round
Initial review.

## Outcome summary
- **Security**: No Critical/Major. The AAD model, the no-fallback decision, cross-entry/user transplant protection, and the enum recreate migration are all assessed sound — with a constructive proof that no PH-encrypted personal-history blob can have been persisted.
- **Functionality**: Approach correct. Findings are dead-code-removal completeness (`HISTORY_BLOB_MAX`, live operational doc) + plan wording (`audit_outbox` is `Json`, not enum).
- **Testing**: Approach correct, but two Critical test-rigor gaps in the contracts (vacuous unit assertion; missing real-crypto integration test) — now encoded as acceptance criteria in C4/C5.

All findings were incorporated into the plan (no deferrals). Resolution noted per finding below.

## Functionality Findings
- **F1 Minor — `audit_outbox` is `Json`, not the `AuditAction` enum.** Plan over-stated the migration burden. → Plan corrected: only `audit_logs.action` uses the enum; recreate touches one column. (Cross-codebase findings section.)
- **F2 Minor — `HISTORY_BLOB_MAX` becomes dead after C7.** Used only by the two removed schemas (`common.ts:101`, consumers in `entry.ts`, tests in `common.test.ts`/`entry.test.ts`). → Added to C7 + forbidden-pattern list.
- **F3 Minor — `docs/operations/audit-log-reference.md` (live op doc) references `ENTRY_HISTORY_REENCRYPT`** at `:180`, `:392`, `:410`. → Added to C8.
- **F4 Minor — stale comment `entry-history-section.tsx:224-225`** asserts the PH scope is intentional. → C1/C4 already require replacing it; reinforced.
- **F5 Major — webhook `events String[]` rows may hold stale `ENTRY_HISTORY_REENCRYPT`.** Harmless (emitter gone, dispatcher never matches), no cleanup needed. → Documented in Considerations.
- **F6 Minor (downgraded from Major) — name the `:318` array explicitly as `AUDIT_ACTION_VALUES`** (file has multiple arrays). The finding's own analysis shows the coverage test is a safety net if missed. → C8 now names `AUDIT_ACTION_VALUES` (def `:215`).

Verified by Functionality reviewer: AAD producer→consumer byte-match (fresh + post-rotation); per-row no-try/catch in rotation; full removal enumeration; Prisma lockstep; aadVersion-0 guard preserved; PATCH unreachable.

## Security Findings
- **S1 Minor — `HISTORY_BLOB_MAX` dead** (= F2). → C7.
- **S2 Minor/Advisory — restore route does not assert `history.aadVersion === entry.aadVersion`.** Pre-existing, not reachable today, not worsened. → Documented in Considerations as future hardening (out of scope).
- Key confirmations (no finding): Q1 no new rollback/transplant attack (PH binding was never operative; new state == team path, already trusted); Q2 cross-entry/user binding preserved (golden vector `aad-parity.test.ts`); Q3 rotation integrity restored, no regression; Q4 no-fallback proof sound (all `PasswordEntryHistory.encryptedBlob` writers enumerated — only verbatim PV snapshots reach DB; rotation aborts before persist); Q5 migration transactional, one column; Q6 `prisma/migrations/` grep exclusion correct.

## Testing Findings
- **T1 Critical — C4 unit assertion is vacuous.** `expect(mockDecryptData).toHaveBeenCalled()` passes even with the wrong AAD. → C4 now requires `buildPersonalEntryAAD` called with `("user-1","entry-1","blob")` AND `decryptData` called with that return value as `additionalData`.
- **T2 Critical — C5 integration test does not exist.** Harness supports real crypto (`vault-rotate-key-attachments.integration.test.ts`). → C5 now specifies a real producer→consumer round-trip + an anti-vacuous negative-decrypt assertion (using PV "overview", since PH is deleted).
- **T3 Major — audit i18n coverage tests don't detect orphan labels.** Plan's "green by construction" was wrong for the label-deletion direction. → C9 corrected: grep is the gate; optional orphan-key assertion recommended.
- **T4 Minor — stale mock comment `:53-55`.** → C4/C9 require removal.
- **T5 Major — `route.test.ts` dead locals after PATCH removal** (`PATCH` import, `updateMany` mock, `createHash`, PATCH fixtures) → lint/TS failure. → C9 enumerates them.
- **T6 Minor — C2 rotation-with-history has no automated test.** → C9 adds a jsdom regression guard asserting the entry AAD is used for both decrypt-old and encrypt-new.
- **T7 Minor [Adjacent] — historical parity gap** (no PV-vs-PH parity test existed). No action (PH deleted).
- **T8/T9/T10 Minor — confirm C9 test edits** (hard TS errors on stale imports; duplicate schema describes; whole-file deletion is safe). → C9 confirmed/expanded.
- Coverage gaps noted: rotation-with-history (T6, addressed), aadVersion-0 branch (guard unchanged, low risk), post-rotation re-view (C5/manual).

## Adjacent Findings
- T7 (Testing→historical), F4 (Func→reinforced in C1). Routed and resolved above.

## Recurring Issue Check (preserved per expert)
### Functionality expert
R1–R37 checked. Findings: R3 → F2, F3 (propagation completeness: dead const + live doc); R24 → enum recreate (well-established pattern, no row uses value); R37 → F5 (webhook string persistence). R11/R12 → both HISTORY groups + AUDIT_ACTION_VALUES enumerated. All others Checked—no issue / N/A.

### Security expert
R1–R37 + RS1–RS4 checked. No Critical/Major. RS4 (no personal data in artifacts) — clean. R12/R13 (audit + webhook group coverage) — clean after removal. R19 (Prisma enum lockstep) — compile-time enforced. R20 (migration safety) — transactional, one column. R35 (audit-outbox drain window) — theoretical only. Only S1 (Minor, = F2) + S2 (Minor advisory).

### Testing expert
R1–R37 + RT1–RT5 checked. RT1 → T1, T2 (mock-reality; coupled assertion + real-crypto round-trip required). RT4 → T1 (vacuous pass), T2 (anti-vacuous negative). RT5 → C5 uses the real `crypto-client` primitives. All others Checked—no issue / N/A.

## Disposition (Round 1 — Part A)
All Critical/Major/Minor findings incorporated into the plan (C4, C5, C7, C8, C9, Considerations) — none deferred. The core design (entry-AAD model, no fallback, full dead-code removal incl. Prisma enum) was validated by all three experts. Part A contracts C1–C10 `locked`.

---

# Round 2 — Part B (structural mechanism, C11–C16)
Date: 2026-05-31. Three expert sub-agents reviewed the Part B structural-elimination contracts.

## Outcome: 1 Critical (corrected), several Major (corrected) — Part B reframed.
- **[Critical] S1/F1 — emergency AAD reformat would destroy data.** `crypto-emergency.ts:89` `buildAAD` is pipe-delimited UTF-8 (`grantId|ownerId|granteeId|kv|wv`), NOT the registry's length-prefixed binary. "Folding into the registry" as first written would change AAD bytes → every existing emergency-access escrow (ECDH secret-key wrap) becomes undecryptable. Same risk for `webhook-aad.ts` (pipe) and `account-token-crypto.ts` (colon). **Correction**: C11 reframed to *register-and-pin-in-place* — these keep their current wire format; only a *named builder + ledger entry + byte-pinning golden vector* are added. No reformat. (Sec escalate:true.)
- **[Major] F2/S2/F3 — surface is larger & multi-format.** Missed: `crypto-team.ts:186 buildTeamKeyWrapAAD` (3rd inline re-impl of the encoder, scope OK); Node-`crypto` `setAAD` AEAD in `envelope.ts`/`crypto-server.ts` (an `additionalData`-only gate misses these); `webhook-aad.ts`/`account-token-crypto.ts` bespoke formats; intentional NO-AAD subtle sites (export/recovery/wrapSecretKey/session) that must not be flagged. **Correction**: C11/C12/C13 surface + allowlist + gate-detection expanded to cover inline re-impls, Node setAAD, both `src/` and `extension/src/`.
- **[Major] F7 — existing infra.** `crypto-domain-ledger.md` + `check-crypto-domains.mjs` (CI + pre-pr.sh:130) already is the registry/gate. **Correction**: C13 reframed to *extend* it, not add a parallel `check-aad-ssot.sh`.
- **[Major] T9 — affects Part A.** The ledger has a `PH` row (`crypto-domain-ledger.md:32`); C3 removing `SCOPE_PERSONAL_HISTORY` without removing the row fails `check-crypto-domains` in CI. **Correction**: added to C3.
- **[Major] F4/S4/T1/T2 — parity gaps.** OV/IK/OK have no app↔ext golden vector; iOS struct-probes OV/AT/IK instead of full-byte. **Correction**: C14 enumerates concrete scopes + full-byte iOS.
- **[Major] S2/T3/T4/F5 — gate rigor.** Gate must catch inline re-impls + Node setAAD; test-presence must be vitest-level (file existsSync / manifest import), not name-grep; ship a gate self-test fixture; manifest must be **bidirectional** (S7/T4). **Correction**: C13/C16 updated.
- **[Minor] T10/F6/S5/S6** — drop non-enforceable manifest fields (sealer/opener); clarify AR is byte-safe vs emergency is not; `buildAADBytes`-private makes gate defense-in-depth. All incorporated.

## Recurring Issue Check (Round 2, per expert)
- Functionality: R1 (buildTeamKeyWrapAAD reimpl → F3), R3 (surface enumeration incomplete → F2), R34 (adjacent stragglers). 
- Security: R34/R35 crypto-material carve-out applied; RS1 byte-preservation = integrity (S1 Critical); gate bypass analysis (S2). No new attack surface beyond the (corrected) reformat risk.
- Testing: RT1/RT4/RT5 (parity must use real crypto + cross-decrypt; gate self-test; no vacuous manifest grep). 

## Disposition (Round 2)
Critical + Major findings incorporated into the plan (C3 ledger; C11 byte-preserve/register-in-place; C12 Node-setAAD allowlist; C13 extend-existing + self-test + vitest-level presence; C14 concrete scopes + full-byte iOS; C15 pin pipe/colon bytes; C16 bidirectional, drop prose fields). Part B reframed from "unify format" to "register-and-pin-in-place + enforce coverage by extending the existing gate". Contracts C11–C16 `locked`. The byte-preservation invariant will be re-verified in Phase 3 (post-implementation) review.

## Post-review user decision — supersede "register-in-place" with "unify ALL to binary"
The round-2 Critical (don't reformat emergency/webhook/account-token) was correct *given* no-migration. User then directed: migration is not a concern → **reformat them all to the single binary `buildAADBytes` format** (eliminate the 3-format-family fragmentation entirely, not just gate it). C11 updated accordingly. Verified-safe: `OK` inline encoder is byte-identical to `buildAADBytes("OK",4,…)` → team-key data unaffected; all client E2E scopes already binary → vault data unaffected. **Breaking (accepted, pre-1.0, no migration)**: Account OAuth tokens (self-healing via re-OAuth), webhook secrets (admin re-gen), emergency-access escrows (grantor re-establishes grant). Bonus: binary length-prefixing obsoletes account-token's `":"`-rejection and webhook's UUID-format hand-rolled delimiter defenses. Manifest drops the `format` field (one format); C13 forbids any string-delimited AAD outright.

