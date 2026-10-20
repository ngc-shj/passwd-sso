# Plan Review: tenants-table-rls

## Round 1 — 2026-10-21

### Changes from Previous Round

Initial review. Local LLM pre-screen (3 findings: load-test roots, unnamed C2 grant, unnamed
self-test model) was applied before the round. Dedup was manual (json-index join); no Ollama merge.

### Functionality Findings

| ID | Sev | Label | Finding | Disposition |
|----|-----|-------|---------|-------------|
| F1 | Major | design R18/R3 | C4 leaves `raw-sql-usage.txt` entry stale → `check-raw-sql-usage` STALE_EXEMPT | Fixed: C4 removes the entry |
| F2 | Major | design R50/R41 | Drift-gate exemption removal is a no-op (`hasTenantId` skip first); FORCE unobservable by non-owner acceptance | Fixed: explicit Check A branch + self-tests; verify SQL asserts `pg_class` flags (merged with T5) |
| F3 | Major | design R47/R48 | C1 forbidden regex matches the correct multi-line form; second adjudicator beside `[E-RLS-TENANT-INITPLAN]` | Fixed: pattern dropped, INITPLAN check is the adjudicator (merged with T13) |
| F4 | Major | design | C1 (a)/(c) and C5 outcomes depend on connection state / mechanism | Fixed: (a1)/(a2), (c1)/(c2), C5 on a fresh connection (merged with T2, T9, T12) |
| F5 | Minor | design R17 | Inline `inSweepTx` arrow would fail the read-context gate | Fixed: declared `listTrashRetentionTenants` + `assertSweepBypass` |
| F6 | Minor | design D2 | New C3 grant duplicates `SYSTEM_MAINTENANCE_TENANT_LOOKUP` | Fixed: reuse it; ALLOWED_USAGE entry named (merged with S8) |
| F7 | Minor | prose R29 | C4 position-analysis command covers the wrong callers | Fixed: command over `logAuditInTx` + `enqueueAuditInTx` (merged with S3) |
| F8 | Minor | design | `enqueueAuditInWorkerTx` "mirrors" comment diverges | Fixed: C4 states the twin keeps its probe |
| F9 | Major (Adjacent) | design R19 | More mocked tests break than the one cited | Fixed: list in Testing strategy (merged with T3) |

### Security Findings

| ID | Sev | Label | Finding | Disposition |
|----|-----|-------|---------|-------------|
| S1 | Major | design R49/R54 | C1 "enforceable boundary / schema-enforced" overstated — GUCs are settable by any SQL-capable code | Fixed: control class restated, scope named |
| S2 | Major | design R49/R38 | Verifier silent-inert class open at runtime (0 tenants reads healthy) | Fixed: C3 treats empty enumeration as an error, unit cell |
| S3 | Minor | prose R29 | = F7 | Fixed (F7); RI-bypass citation added |
| S4 | Minor | prose R49 | R5 broader than the gate | Fixed: R5 reworded (merged with T14) |
| S5 | Minor | design R14 | `passwd_app` keeps DELETE on `tenants` | Follow-up SC5 (Anti-Deferral below) |
| S6 | Minor | prose R42 | Runbook SQL on `tenants` runs as RDS owner | Fixed: C7 |
| S7 | Minor | design R14/R16 | anchor/dcr roles outside RDS convergence/audit | Scoped V1 claim; follow-up SC6 |
| S8 | Minor | design D2 | = F6 | Fixed (F6) |

### Testing Findings

| ID | Sev | Label | Finding | Disposition |
|----|-----|-------|---------|-------------|
| T1 | Major | design R50/R42 | Output grep for reports can never hit; afterEach is the detector; `toContainEqual` absorbs extras | Fixed: grep dropped, exact equality |
| T2 | Major | design RT4 | (a) nondeterministic | Fixed (F4) |
| T3 | Major | design R19 | Unlisted unit-test breakage | Fixed (F9) |
| T4 | Major | design RT7 | `sweep-dispatch-bypass` count stays N+2, per-tenant trash tx uncovered | Fixed: fake returns one tenant, count + `bypass_tables` asserted |
| T5 | Major | design R41 | = F2 | Fixed (F2) |
| T6 | Major | design R50 | Verify block placement, markers, 4b exclusion, count-based asserts | Fixed: placement before Block 2, 4b exclusion dropped, id-based |
| T7 | Major | design RT7 | Negative-test harness cannot break the block | Fixed: new case with cleanup restore |
| T8 | Major | design R21/R31 | Mutation gaps; DB mutations need isolation | Fixed: rows added; BEGIN/ROLLBACK or throwaway DB |
| T9 | Major | design RT8 | C5 cell green before and after | Fixed (F4): asserts message names `tenants` |
| T10 | Minor | design RT5 | C2 cell must use GC role | Fixed |
| T11 | Minor | design | C3 "≥1 tenant" satisfied by sentinel | Fixed: count equality |
| T12 | Minor | design RT8 | (c) UPDATE B is USING-filtered | Fixed (F4) |
| T13 | Minor | design R47 | = F3 | Fixed (F3) |
| T14 | Minor | prose R49 | = S4 | Fixed (S4) |

### Anti-Deferral entries

- **S5 (SC5)** — Out of scope. Worst case: SQL-capable compromise of `passwd_app` deletes a tenant
  with no rows in the 48 RESTRICT-referencing tables, cascading its claims, memberships, operator
  tokens, webhooks, delivery targets and directory-sync rows (7 `onDelete: Cascade` relations). Likelihood low (requires SQL
  execution as the app role, which already defeats the GUC-based policy). Cost to fix here: a
  privilege change across initdb, `bootstrap-rds-roles.mjs`, `app-role-denied-privileges.json`,
  `db-grants-manifest.json` and their tests — a separate least-privilege change, filed as a follow-up.
- **S7 (SC6)** — Pre-existing. Worst case: an RDS deployment creates the anchor/dcr roles with
  BYPASSRLS out of band and nothing asserts it. Likelihood low (created by migrations/initdb with
  NOBYPASSRLS). Cost: extending ROLES/AUDITED_ROLES with password handling and audit manifests —
  follow-up issue.

### Recurring Issue Check

#### Functionality expert
R1 F6; R2 ok; R3 F1; R4 n/a; R5 ok; R6 ok; R7 n/a; R8 n/a; R9 ok; R10–R13 n/a; R14 ok; R15 ok;
R16 ok; R17 F5; R18 F1; R19 F9; R20 n/a; R21 n/a; R22 ok; R23 n/a; R24 ok; R25–R28 n/a; R29 F7;
R30–R32 n/a; R33 ok; R34 ok; R35–R39 n/a; R40 ok; R41 F2; R42 ok (re-derived); R43–R46 n/a;
R47 F3; R48 F3; R49 ok; R50 F2; R51 n/a; R52 ok; R53 n/a; R54 ok; R55 ok; R56–R57 n/a.

#### Security expert
R1–R2 n/a; R3 ok; R4 n/a; R5 ok; R6 ok; R7–R8 n/a; R9 ok; R10–R13 n/a; R14 S5, S7; R15 ok;
R16 S7; R17 ok; R18 S8; R19 adjacent; R20–R23 n/a; R24 ok; R25–R28 n/a; R29 S3, S6; R30–R31 n/a;
R32 ok; R33 n/a; R34 S5/S7 follow-ups; R35 adjacent; R36–R37 n/a; R38 S2; R39–R40 n/a; R41 S2;
R42 S3, S6 (member set otherwise clean); R43 ok; R44–R46 n/a; R47 ok; R48 n/a; R49 S1, S4;
R50 ok; R51 n/a; R52 ok; R53 n/a; R54 S1; R55 ok; R56–R57 n/a. RS1–RS6 n/a.

#### Testing expert
R1–R2 n/a; R3 T3; R4–R15 n/a; R16 ok; R17 n/a; R18 ok; R19 T3; R20 n/a; R21 T8; R22–R28 n/a;
R29 ok; R30 n/a; R31 T8; R32 n/a; R33 ok; R34–R40 n/a; R41 T5; R42 T1; R43–R46 n/a; R47 T13;
R48 n/a; R49 T14; R50 T1, T6; R51–R54 n/a; R55 T6; R56–R57 n/a. RT1 T3, T4; RT2 ok; RT3 n/a;
RT4 T2; RT5 T10; RT6 ok; RT7 T1, T4–T8; RT8 T9, T12; RT9 n/a; RT10 T5; RT11 T7.

## Round 2 — 2026-10-21

### Changes from Previous Round

Plan revised for all round-1 findings (C1 control class restated, C3 empty-enumeration error, C4
command/allowlist/twin, C5/C1 outcomes pinned, C6 drift branch + verify block + negative case, C7
added, test list extended).

### Findings and dispositions

| ID | Expert | Sev | Label | Finding | Disposition |
|----|--------|-----|-------|---------|-------------|
| S9 / R2-F1 / N4 | Sec, Func, Test | Major | design R49/R50/R41 | C3 keyed to `verified < tenantCount` (0<0); deployed alert is `erroredTenantCount > 0`; heartbeat stub ordering | Fixed: empty → heartbeat with `erroredTenantCount >= 1` + `TENANT_ENUMERATION_EMPTY`, no throw; alerts.md text; stub serves enumeration tx separately |
| S10 / R2-F5 | Sec, Func | Major / Minor | design R54 / R41 | C7 preamble form unspecified; separate statements; bypass vs scope | Fixed (merged): `BEGIN READ ONLY; SET LOCAL app.tenant_id = <sentinel>; …; ROLLBACK;` — no bypass |
| S11 | Sec | Minor | prose R29 | S5 worst case omits 7 cascade relations | Fixed: Anti-Deferral text |
| N1 | Test | Major | design R33/R16 | Seed-dependent verify block fails local pre-pr | Fixed: two codes; pre-pr allow-list |
| N2 / R2-F2 | Test, Func | Major | design R31/RT11 | Negative case: widened variant hits `[E-RLS-SYM]`; restore in `cleanup()` too late; restore text drift | Fixed: symmetric variant only; immediate restore from `pg_get_expr` snapshot, asserted; CI-only |
| N3 | Test | Major | design RT8 | (c2) green under widened WITH CHECK (23505/23503) | Fixed: 42501 pinned, fresh ids |
| N5 | Test | Minor | design R31 | C5 red proof mechanism | Fixed: DISABLE RLS + SET LOCAL ROLE in rolled-back tx |
| N6 | Test | Minor | prose R29 | toContainEqual cells mis-cited | Fixed: four cells in rls-bypass-grants; definer test after #922 merges |
| N7 / R2-F3 | Test, Func | Minor | prose R29/R50 | (c1) superuser read-back impossible in verify SQL; 4b covers (e) not (d) | Fixed: read back under scope B; (d) integration-only |
| R2-F4 | Func | Minor | prose R50 | Existing dispatch guard red only on `''` connections | Fixed: claim dropped |
| R2-F6 | Func (Adjacent) | Minor | design R17 | sweep-bypass-assert per-member list | Fixed: function exported, deny/allow pair |

### Recurring Issue Check

- Functionality: R2 R2-F2; R17 R2-F6; R29 R2-F3; R31 R2-F2; R41 R2-F1, R2-F5; R50 R2-F1, R2-F4; R44 ok; all others ok or n/a (R1–R57 enumerated in the expert output).
- Security: R14 ok; R16 ok; R29 S11; R38 S9; R41 S9; R49 S9, S10; R50 S9; R54 S10; all others ok or n/a; RS1–RS6 n/a.
- Testing: R16 N1; R18 N1; R19 N4; R29 N6; R31 N2, N5; R33 N1; R50 N4, N7; all others ok or n/a; RT1 N4; RT7 N2–N4; RT8 N3; RT11 N2; RT4/RT5/RT10 ok.

## Round 3 — 2026-10-21

### Changes from Previous Round

All round-2 findings applied (see Round 2 table).

### Findings and dispositions

| ID | Expert | Sev | Label | Finding | Disposition |
|----|--------|-----|-------|---------|-------------|
| — | Security | — | — | No findings (C7 tenant-scoped block verified safe and sufficient for all four runbook queries) | — |
| P1 | Testing | Major | design RT8/RT7 | (c2) UPDATE of another tenant under scope A is USING-filtered, never 42501 | Fixed: UPDATE under the row's own scope C |
| P2 | Testing | Minor | design RT11 | Verify-SQL (c2) setup must not commit a row on the dev DB | Fixed: INSERT fresh id + UPDATE A0 under scope A0, each in an `insufficient_privilege` sub-block |
| P3 | Testing | Minor | design R50 | Fatal checks must precede allow-listed ones in the block | Fixed: order (a1), flags, (b)/(c1)/(c2) |

### Recurring Issue Check

- Security: all R1–R57 ok or n/a; RS1–RS6 n/a.
- Testing: R50 P3; RT7/RT8 P1; RT11 P2; all others ok or n/a.
- Functionality: pending at time of writing (see below).
| F1 | Functionality | Minor | design R31/R41 | (c2) UPDATE scope; created tenant must not persist | Fixed (with P1/P2): integration cell creates/removes C as superuser; verify SQL creates no row |
| F2 | Functionality | Minor | design R41 | One-line C7 block breaks with `\copy` | Fixed: one statement per line, `\copy` form executed in acceptance |
| F3 | Functionality | Minor | prose R29 | Member-set row and SC3 contradict C7 | Fixed |

Functionality Recurring Issue Check (round 3): R29 F3; R31 F1; R41 F1, F2; all others ok or n/a.

## Round 4 — 2026-10-21

Functionality and Testing re-reviewed the round-3 fixes: **No findings** from either (Security
returned No findings in round 3). All contracts C1–C7 locked; plan review complete after 4 rounds.

Recurring Issue Check (round 4): Functionality — all R1–R57 ok or n/a. Testing — all R1–R57 and
RT1–RT11 ok or n/a.
