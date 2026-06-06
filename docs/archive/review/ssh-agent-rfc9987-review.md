# Plan Review: ssh-agent-rfc9987
Date: 2026-06-06
Review round: 1

## Changes from Previous Round
Initial review (3 parallel expert sub-agents: functionality, security, testing).

## Functionality Findings

- **F1 [Critical] — C1 false justification + missing Prisma enum migration.** `AuditAction` IS a Prisma DB enum (`prisma/schema.prisma:868`) and `AUDIT_ACTION` is `} as const satisfies Record<AuditAction, AuditAction>` (`audit.ts:207`). Adding actions without the Prisma enum member is a TS compile error AND a runtime insert failure. The plan's "no storage-layer constraint available" is false. Fix: add members to `enum AuditAction` + new migration; correct invariant to type-enforced + schema-enforced (strongest form). **Verified by orchestrator.**
- **F2 [Major] — missing `groupSsh` i18n + wrong group value** (merged with T1). See T1.
- **F3 [Major] — webhook subscription group is separate.** `TENANT_WEBHOOK_EVENT_GROUPS` (`audit.ts:734`) is hand-picked, not auto-derived from display groups (R11). Must explicitly decide membership. **Verified.** Resolution: v1 emits PERSONAL-scope only → no TENANT group, no webhook membership needed (see F4 resolution).
- **F4 [Major] — audit scope vs group placement inconsistency.** delegation/check emits PERSONAL only (`personalAuditBase`); group membership is a display taxonomy, not an emission. Putting actions in TENANT group without TENANT emission is misleading. Resolution: **PERSONAL scope + PERSONAL group only** for v1 (tenant governance of SSH signing deferred to SC3). Resolves F3+F4 together.
- **F5 [Major] — keyId `uuid` rejects CUID** (merged with S3). PasswordEntry IDs are mixed CUID/UUID; use `z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)` like delegation/check (`route.ts:32`). **Verified** (project memory `project_cuid_uuid_inconsistency`).
- **F6 [Major] — existing CLI tokens lack `ssh:sign` → silent fail-closed after upgrade.** Granted scopes are frozen; users must re-login. Fix: add `ssh:sign` to `CLI_SCOPES` (`oauth.ts:19`, single constant feeding 3 sites — verified), and the CLI must detect scope-deny (403 unauthorized) vs entry-deny and message "re-login required". Document in manual test + scenarios.
- **F7 [Minor] — lock the C2 four-file edit set.** `MCP_SCOPES = Object.values(MCP_SCOPE)` so most sites auto-pick-up; only manual edits: `mcp.ts`, `McpConsent.json` en+ja (`scopeDescriptions`, no CI gate), `cli/oauth.ts CLI_SCOPES`. **Verified.**
- **F8 [Minor] — note C3 success body intentionally omits `sessionId`/`expiresAt`** (no session in per-sign model).
- **F9 [Minor] — C5 async queue under-specified:** partial-buffer backpressure, mid-queue error → still write FAILURE and continue, size-cap reachable while awaiting.
- **F10 [Minor] — C8 "unreadable column → deny" branch inapplicable** (merged/reconciled with S6). `requireReprompt` is always serialized (`passwords/route.ts:123,211` — verified). Resolution: required boolean; non-boolean/undefined → treat as `true` (deny-side) with a test.
- **F11 [Adjacent→Security]** C6 verify is net-new crypto (no existing verify helper). → S4/T3.
- **F12 [Adjacent→Testing]** golden-vector capture design. → T3.

## Security Findings

- **S1 [Major] — C3 tenant-scoping mechanism underspecified.** delegation/check uses `withBypassRls(prisma, ..., BYPASS_PURPOSE.CROSS_TENANT_LOOKUP)` + `where: { userId }` (verified `route.ts:118-137`), NOT `withTenantRls`. Lock one concrete pattern; the `userId` predicate is the authz boundary. Add test: another user's keyId → `entry_not_found`.
- **S2 [Major] — SSH signatures logged as `ACTOR_TYPE.HUMAN`, not `MCP_AGENT`.** `personalAuditBase` doesn't set actorType (defaults HUMAN, `audit.ts:145`). New action → no back-compat excuse. Fix: `actorType: resolveActorType(authResult)` (helper exists `audit.ts:100` — verified) on both emissions. Anti-forensic/attribution gap.
- **S3 [Minor→Major] — keyId validation + length caps** (merged with F5). Add `fingerprint: z.string().max(100)`, `host.hostKeyFingerprint: z.string().max(100)`.
- **S4 [Minor, correctness-load-bearing] — session-bind verify must bind signature algorithm to host-key type.** Read host-key type from `hostKeyBlob`, select verify primitive from it, reject mismatched signature algorithm name. Add test "ed25519 hostkey + rsa-sha2-256 sig name → false".
- **S5 [Minor] — `forwarded` is audit-only on BOTH ends in v1.** State the server ignores `forwarded` for the authz decision (no implicit "forwarding blocked" claim). Ties to SC4.
- **S6 [Minor] — confirm-gate flag-load fail-open risk** (reconciled with F10). Make `requireReprompt` required boolean; default deny-side if non-boolean.
- **S7 [Minor] — 429 IS audited via the shared rate-limit helper** (`checkRateLimitOrFail` → `emitRateLimitFailClosed`), not via `SSH_KEY_SIGN_DENIED`. Clarify the prose.
- **S8 [Minor, citation] — RFC 9987 citation.** Sub-agent could not verify. **Orchestrator resolution: VERIFIED** against rfc-editor.org — RFC 9987 = "Secure Shell (SSH) Agent Protocol"; message numbers SUCCESS=6, REMOVE_ALL_IDENTITIES=19, EXTENSION=27, EXTENSION_FAILURE=28, EXTENSION_RESPONSE=29 confirmed. Safe to replace `draft-miller` with RFC 9987.
- **[Adjacent] scope-surface (S8 tail):** state the SSH-agent token's TOTAL scope set (`ssh:sign` + the read scope needed to fetch the SSH_KEY list/blob + `vault:unlock-data`) and confirm it does NOT include `credentials:use` (arbitrary password decrypt).

## Testing Findings

- **T1 [Critical] (= F2) — group key value breaks i18n coverage test.** Convention is `"group:<camel>"` (`audit.ts:411 DELEGATION: "group:delegation"` — verified); the coverage test does `group.split(":")[1].charAt(0)` (`audit-log-keys.test.ts:40` — verified), so value `"SSH"` → `undefined.charAt` → TypeError (test errors, masks the gap). Fix: `AUDIT_ACTION_GROUP.SSH = "group:ssh"` + `groupSsh` label en+ja.
- **T2 [Major] — C8 `/dev/tty` has no mock precedent.** Use `process.stdin.isTTY` (precedent: `unlock.ts:38`, `agent-decrypt.test.ts`) or an injectable prompt dependency (extend the C10 DI pattern one level). Makes no-TTY/yes/no all deterministically testable.
- **T3 [Major] — C6 verifier primitive does not exist.** No SSH-wire-pubkey→KeyObject helper in repo (openssh-key-parser parses private keys only). "Reuse existing helpers" is inaccurate — net-new crypto. Name the wire→KeyObject builder as a tested unit. Golden vector: one captured ed25519 frame + **synthetic** per-keytype vectors (sign-then-verify in-test) for rsa/ecdsa/unsupported.
- **T4 [Minor] — make 503 fail-closed test mandatory.** Simulable via `mockRateLimiterCheck.mockResolvedValue({ redisErrored: true })`; not covered by delegation test, so genuinely new coverage.
- **T5 [Minor] — C5 ordering test vacuous-pass guard (RT4).** Enqueue both messages while first authorize pending (deferred promise), assert second reply not written while pending (write-count 0), then resolve and assert order. Drive the real `handleConnection` queue (RT5).
- **T6 [Minor] — name the per-contract test file** for C6/C7/C8 (`ssh-session-bind.test.ts`, `ssh-sign-authorizer.test.ts`, `ssh-confirm.test.ts`).

## Adjacent Findings
F11 (→S4/T3 crypto), F12 (→T3 golden vector), S8-tail (→C2 scope surface). All routed and incorporated above.

## Quality Warnings
None — all findings carry file:line evidence; orchestrator independently verified F1, T1, S1, S2, S6/F10, F6, F3.

## Recurring Issue Check
### Functionality expert
R1–R37: performed; key hits R5 (F1 false justification), R6 (F1/F2/F3 schema+test downstream), R11 (F3), R12 (F1/F2/F3), R19/R21 (F1 migration on dev DB), R26 (ja 保管庫), R27 (const-object — OK), R29 (constants OK), R37 (SC3 commonization). Remainder N/A.
### Security expert
R1–R37 + RS1–RS4: performed; hits R2/R17 (S1), R8 (S4), R9 (S6), R14/RS3 (S3), R16 (S2), R29 (S8). No Critical → no escalation. RS2/RS4 confirmed reusable.
### Testing expert
R1–R37 + RT1–RT6: performed; hits R8/RT4 (T5), RT1/RT5 (T3), RT2 (T2/T3), RT6 (T6), R13 (T1). R35 manual-test tier confirmed correct.

---

# Plan Review: ssh-agent-rfc9987 — Round 2 (incremental)
Date: 2026-06-06

## Changes from Previous Round
Applied all round-1 fixes (C1 Prisma enum+migration; group:ssh+groupSsh; PERSONAL-only scope; keyId regex; withBypassRls authz; resolveActorType; C6 algorithm-binding+net-new-crypto; C8 isTTY+DI; re-login flow). Round 2 verified each fix against code.

## Round-1 fix verification
All round-1 findings (F1–F10, S1–S8, T1–T6) **verified RESOLVED** against code by the three experts (migration shape `ALTER TYPE ... ADD VALUE IF NOT EXISTS` confirmed safe/additive; resolveActorType→MCP_AGENT confirmed audit.ts:108; withBypassRls authz boundary + userId-from-token confirmed; i18n derivation `group:ssh`→`groupSsh` confirmed audit-log-keys.test.ts:40; isTTY mock precedent confirmed; synthetic crypto vectors feasible via existing JWK builders).

## New Findings (Round 2)
- **F11 [Major] — RESOLVED.** C2's "must exclude `credentials:use`" was architecturally impossible: the CLI mints one shared `CLI_SCOPES` token for all commands; decrypt needs `credentials:use` (`delegation/route.ts:131`). Reframed honestly — `ssh:sign` is a distinct server-side gate; sign-only-token minimization deferred to **SC6**. (`feedback_no_false_technical_justification`.)
- **T7 [Major] — RESOLVED.** C5 tests need `handleConnection`/`handleMessage` exported (mirrors agent-decrypt). Added to C5 signatures.
- **S9–S11 [Minor] — no action.** Per-sign self-DoS (already documented), `host`/`fingerprint` log-injection (mitigated: Json column + CSV escaping + max(100) caps), token-replay (standard bearer model, revocation immediate). All confirmed safe by code inspection.
- **S12 [Minor] — RESOLVED.** C3 prose overstated 429 auditing; corrected — only 503 is audited (`emitRateLimitFailClosed`), 429 returns envelope without an audit row.
- **T8 [Minor] — RESOLVED.** Connection-isolation test now observes via the `authorizeSign` spy args, not the internal `binding` field.
- **T9 [Minor] — RESOLVED.** Captured ed25519 fixture now paired with a flip-byte→false assertion.

## Round-2 verification notes
- C3 route-test reuse holds: delegation/check harness mocks `withBypassRls` as passthrough (`route.test.ts:15,30`); 503 via `redisErrored` is net-new coverage the harness supports.
- F1 migration correctly routed to manual dev-DB run (no automated migration-executability test exists by design).
- No regressions; CSRF gate covers cookie-bearing POSTs to the new route (`csrf-gate.ts:46`).

## Recurring Issue Check (Round 2)
Functionality: R5/R6/R12 (F11 scope-constant downstream + false-justification — resolved). Security: RS1 (S1 authz verified), RS2 (S4 downgrade closed), RS3/RS4 (S10/S12 metadata+rate-limit verified), R16 (S2 attribution verified). Testing: RT1/RT5 (T7 export seam), RT4 (T8/T9 non-vacuity), R13 (T1 derivation verified).

---

# Plan Review: ssh-agent-rfc9987 — Round 3 (convergence)
Date: 2026-06-06

## Changes from Previous Round
Applied round-2 fixes (F11 reframing, T7 export, S12 prose, T8/T9 test wording).

## Findings (Round 3)
- **Testing: No new findings** — T7/T8/T9 verified resolved and non-vacuous; T2/T4/T5/T6 survive intact; no regression.
- **F12 / S13 [same issue, Major/Minor] — RESOLVED.** Both functionality and security independently flagged that the round-2 F11 reframing did not propagate to the Non-functional requirements (plan line 37 still asserted the retired "an SSH-agent token must not be able to decrypt arbitrary passwords" overclaim). Fixed: line 37 reconciled with C2/SC6 ("server-side gate, NOT token-level least privilege in v1; token carries credentials:use"). Propagation-swept (`grep` for least-privilege/decrypt overclaims) — all 4 remaining mentions (lines 37, 85, 93, 270) are consistent honest reframings. Matches `feedback_no_false_technical_justification`.

## Convergence
All findings resolved across 3 rounds. No open Critical/Major/Minor. All 10 contracts `locked`. Plan ready for Phase 2.

## Recurring Issue Check (Round 3)
`feedback_no_false_technical_justification` — claim-vs-reality drift caught at the requirements altitude and reconciled; propagation sweep confirmed no other instance. Testing clean.
