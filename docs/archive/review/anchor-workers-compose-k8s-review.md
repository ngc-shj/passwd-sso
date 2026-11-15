# Plan Review: anchor-workers-compose-k8s
Date: 2026-11-16
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screen and merge-findings unavailable (Ollama down);
deduplicated manually from the three experts' json indexes.

## Merged findings and dispositions

Perspective convergence (same root cause, several experts):
- **X1 — compose `.env` reaches every `env_file: .env` service** — S1, S2, S3, S4, S7, F3
  (and T1's env_file-merge observation). Root cause: the plan isolated the keys by
  moving them to a second file, but `init:env`/`.env.example` write them to `.env`,
  the app schema needs the destination (incl. GH token) in `.env`, the anchor key
  CLI reads only `.env`, and `DEPLOYMENT_ID` ends up resolved two ways.
  Resolution (plan v2 C1/C6): keep ONE `.env`; every compose service that loads
  `env_file: .env` blanks, in its `environment:`, the derived set of keys it must
  not hold (publisher-only keys + role passwords + worker role URLs); the publisher
  receives its keys by `${…:?}` interpolation, not `env_file`. The app schema
  normalises blank→unset for those keys and drops the GH-token requirement.
  Severity floor: Major (converged).
- **X2 — compose `stop_grace_period`** — F1, S6. Resolved: C1 I1.5 (`120s`, derived
  from ecs.tf `stopTimeout`).

| ID | Sev | Class | Disposition |
|----|-----|-------|-------------|
| F1/S6 | Major | design | Fixed — C1 I1.5 |
| F2 | Major | design | Fixed — required `:?` kept (ECS parity: publisher is mandatory); upgrade procedure in C5; commit `feat!` (0.x + `bump-minor-pre-major` ⇒ minor bump) |
| F3 | Major | design | Fixed by X1 — destination names stay in `.env`, CLI reads them; operator's own AWS/GH credentials for the CLI; archive step in scenarios + docs |
| F4 | Major | prose | Fixed — C5 member list re-derived by grep; acceptance is a statement-class grep |
| F5 | Minor | design | Fixed — C5 per-destination key table (AWS_REGION; FS needs a named volume, discouraged on same host; no S3 endpoint override) |
| F6 | Minor | design | Fixed — C3 derives stop timeout and single-replica/stop-before-start from ecs.tf via hcl-subset |
| F7 | Minor | design | Fixed — I2.2 exact-set applies to the two new manifests; existing two keep DB-URL-only + no DATABASE_URL |
| S1 | Major | design | Fixed by X1 (blanking gate) — init:env may keep writing keys to `.env` |
| S2 | Major | design | Fixed — C6 narrows app GitHub destination check to `GH_REPO` |
| S3 | Major | design | Fixed — control classes restated: compose blanking = fail-closed verification gate (C3 parse + C7 render); k8s I2.3 = repo hygiene; RBAC documented as the real k8s control |
| S4 | Major | design (pre-existing) | Fixed — role passwords incl. superuser are in the blanked set for `app` and the `.env`-loading workers |
| S5 | Minor | prose | Fixed — R-a lists both legacy volume states (NOLOGIN; LOGIN with the published password) |
| S7 | Minor | prose | Fixed by X1 (single `.env`, interpolation); k8s `deployment-id` in a shareable Secret, I2.3 applies to the key Secret |
| S8 | Minor | design | Fixed — `DATABASE_URL=` on both new services; only `${NAME:?` accepted for passwords and keys |
| S9 | Minor | design | Fixed — C5 documents IRSA trust conditions + prefix-scoped policy mirroring iam.tf; SA `automountServiceAccountToken: false`; Pod Identity uses an association |
| S10 | Minor | prose | Moot for the new file (no new file); docs warn that `config` prints secrets |
| T1 | Major | design | Fixed — C3 normalises spellings, refuses unmodelled forms, reuses `createComposeYamlLoader`, asserts no other compose file defines the new services; C7 render is the merged-view authority |
| T2 | Major | design | Fixed — C7 render step in pre-pr.sh (static-checks), stub `--project-directory` |
| T3 | Major | design | Fixed — one single-step red case per invariant, exact drift lists, no-op mutation guard, structuredClone for semantic mutations |
| T4 | Major | design | Fixed — paired allow case per deny boundary |
| T5 | Major | design | Fixed — recursive `infra/k8s/**`, multi-doc, refuse dist/ in unmodelled kinds/keys, `args`, all Secret-reference forms |
| T6 | Major | design | Fixed — C4 adds `infra/k8s/` (and `infra/terraform/`) to pre-pr.sh `app_paths`; reachability test with negative control |
| T7 | Major | design | Fixed — `typeof value === "string"` + red case |
| T8 | Minor | prose | Fixed — coverage claims narrowed |
| T9 | Minor | design | Fixed — folded into F4 list |
| T10 | Minor | design | Partly — selector/template labels and serviceAccountName asserted in C3; kubeconform: Skipped (see Anti-Deferral) |
| T11 | Minor | design | Fixed — C8 docker smoke runs `--read-only --user 1001:1001 --cap-drop ALL` |
| T12 | Minor | prose (pre-existing) | Fixed — drop the hard-coded count |
| T13 | Minor | design | Fixed — `:?` messages are plain text; C7 render exercises the scanner via check:env-docs |

### Anti-Deferral
- **T10 kubeconform** — Skipped. Anti-Deferral check: cost of fixing now = adding a
  pinned binary download + vendored OpenAPI schemas for one k8s version to CI,
  a new supply-chain surface maintained for two-to-four manifests; cost of not
  fixing = a schema-invalid field reaches an operator's `kubectl apply`, which
  rejects it loudly at apply time (fail-closed, no silent misbehaviour). The
  structural asserts in C3 cover the fields this change introduces. Recorded as
  constraint E1.

## Recurring Issue Check
(Verbatim per-expert blocks retained in the agent hand-backs of this session;
summarised here.)
### Functionality expert
R2 F6 · R3 F1,F2,F4 · R16 F2 · R29 ok (F1 note) · R32 ok · R33 ok · R34 ok · R35 ok · R41 F3,F5 · R42 F4,F6,F7 · others N/A
### Security expert
R2 S7 · R3 S1,S8,S10 · R14 S4,S9 · R16 S6 · R18 S1 · R29 S2,S5,S6,S7 · R32 ok · R33 ok · R34 S4 · R35 note · R41 S2 · R42 route table (9 routes) · R43 S2 · R47 S8 · R48 S7 · R49 S3 · R50 ok · RS3 ok · RS4 ok · others N/A
### Testing expert
R1 T1 · R16 T2 · R18 ok · R29 T8,T12 · R32 ok · R33 T6 · R34 T12 · R40 T7 · R42 T5,T9 · R47 T1,T5,T13 · R48 T1 · R49 T8 · R50 T2 · RT1 T7 · RT2 ok · RT5 T11 · RT7 T2,T3 · RT9 T1,T7 · RT10 T4 · RT11 ok · others N/A

---

# Round 2
Date: 2026-11-16

## Changes from Previous Round
Plan revision 2 replaced the second env file with per-service blanking of a derived
withheld set W, added C6 (app schema), C7 (compose render), C8 (smoke hardening).

## Merged findings and dispositions
Convergence: **Y1 — C7 "no other service holds a W sentinel" contradicts legitimate
holders** — Testing U1 + Functionality N1 (Major floor). Fixed in rev 3: one
(service,key) legitimate-holder table in `scripts/lib/withheld-env.ts` shared by C3
and C7; role passwords judged by key, publisher-only secrets by substring.

| ID | Expert | Sev | Class | Disposition |
|----|--------|-----|-------|-------------|
| U1 / func-N1 | T, F | Major | design | Fixed (Y1) |
| U2 | T | Major | design | Fixed — all-W-blank parse tests; `emptyAsUnset` moved and reused |
| U3 | T | Major | design | Fixed — I1.4 per service name across files; C7 renders all documented `-f` sets |
| U4 | T | Major | design | Fixed — C8 updates the smoke self-test with a red case per flag |
| U5 | T | Minor | design | Fixed — duration parsing |
| U6 | T | Minor | design | Fixed — W floor + automatic-entry red case |
| U7 | T | Minor | design | Fixed — canned-JSON unit tests + real-compose red case, hard-fail in CI without docker |
| U8 | T | Minor | design | Fixed — blank required URL still refused |
| sec-N1 | S | Major | design | Fixed — `GITHUB_TOKEN` in W(c), pinned to from-env |
| sec-N2 | S | Major | design | Fixed — W(a) = every `secret: true` allowlist entry |
| sec-N3 | S | Minor | design | Fixed — retention-gc `DEPLOYMENT_ID=${DEPLOYMENT_ID:-}` + C7 case |
| sec-N4 | S | Minor | design | Fixed — only explicit `""` counts as blank |
| sec-N5 | S | Minor | design | Fixed — SDK default-chain fallback documented; CLI creds from shell |
| sec-N6 | S | Minor | design | Fixed — blank-as-unset only in the app `envSchema` (object preprocess) |
| func-N2 | F | Minor | design | Fixed — scrubbed env for the render |
| func-N3 | F | Minor | design | Fixed — no field wrapper; generate:env-example no-diff acceptance |
| func-N4 | F | Minor | design | Fixed — publisher requires `AWS_REGION` with an S3 bucket; CLI invocation documented |
| func-N5 | F | Minor | prose | Fixed — CONTRIBUTING.md, dev-host-migration.md added |
| func-N6 | F | Minor (Adjacent) | design | Fixed — control class scoped; dev override exception stated |

## Recurring Issue Check
### Functionality expert
R2 ok · R3 N5 · R16 ok · R18 ok · R29 ok (N1) · R32 ok · R33 ok · R34 ok · R35 ok · R41 N3,N4 · R42 N5 · R48 N1 · R49 N6 · R50 N2 · others N/A
### Security expert
R2 N3 · R3 N1 · R14 ok · R16 ok · R18 N2 · R29 N3 · R32 ok · R33 ok · R34 ok · R35 ok · R41 ok · R42 N1,N2 · R43 ok · R47 N4 · R48 N3 · R49 N5 · R50 ok · R52 N6 · RS3 ok · RS4 ok · others N/A
### Testing expert
R1 U2 · R16 U3 · R18 ok · R29 ok · R32 ok · R33 ok · R34 ok · R35 ok · R40 ok · R42 U3 · R47 U3 · R48 U1 · R49 ok · R50 U7 · RT1 ok · RT2 ok · RT5 U2 · RT7 U4,U6 · RT9 U1,U5 · RT10 U8 · RT11 ok · others N/A

---

# Round 3
Date: 2026-11-16

## Changes from Previous Round
Revision 3: shared (service,key) holder table, W(a) from `secret: true`, GITHUB_TOKEN
in W(c), app-only object preprocess, publisher `AWS_REGION`, scrubbed multi-set render.

## Merged findings and dispositions
Convergence: **Z1 — publisher `AWS_REGION` pick rejects compose's `""`** — Testing V1 +
Functionality P1 (Major, design). Fixed in rev 4: publisher applies `emptyAsUnset` to
its optional pass-through fields only; compose-shaped env tests (S3/GH/FS-only);
C7 validates the rendered publisher env. **Z2 — C7 cannot be .mjs** — V2 + func-P2
(Minor): `.ts` under tsx; hcl-subset moved to `scripts/lib/`.

| ID | Expert | Sev | Class | Disposition |
|----|--------|-----|-------|-------------|
| V1 / func-P1 | T, F | Major | design | Fixed (Z1) |
| V2 / func-P2 | T, F | Minor | design | Fixed (Z2) |
| V3 | T | Minor | design | Fixed — real-render allow case; version recorded/printed |
| V4 | T | Minor | design | Fixed — check hard-fails in CI without docker, visible SKIPPED locally |
| sec-P1 | S | Minor | design | Fixed — per-service role-password binding; own-URL user = smoke-map user; superuser-rewrite red case |
| func-P3 | F | Minor | design | Fixed — I1.7 production file only; dev shadowing documented |

## Recurring Issue Check
### Functionality expert
R1 ok · R2 ok · R3 P1 · R16 P3 · R18 ok · R29 ok · R32–R35 ok · R41 P1 · R42 ok · R48 ok · R49 ok · R50 P2 · others N/A
### Security expert
R2 ok · R3 ok · R14 P1 · R16 ok · R18 ok · R29 ok · R32–R35 ok · R41 ok · R42 P1 · R43 ok · R47 ok · R48 ok · R49 ok · R50 ok · R52 ok · RS3 ok · RS4 ok · others N/A
### Testing expert
R1 V2 · R2 ok · R16 ok · R18 ok · R29 ok · R32–R35 ok · R40 ok · R41 V1 · R42 ok · R45 ok · R47–R49 ok · R50 V2,V4 · RT1 V3 · RT2 ok · RT5 V1 · RT7 ok · RT9–RT11 ok · others N/A

---

# Round 4
Date: 2026-11-16

## Changes from Previous Round
Revision 4: publisher emptyAsUnset on pass-through fields, C7 as .ts under tsx,
hcl-subset move, I1.7 scoped to the production file, non-mutating preprocess.

| ID | Expert | Sev | Class | Disposition |
|----|--------|-----|-------|-------------|
| W1 | T | Major | design | Fixed — new C9: meta-gate member set includes `scripts/checks/*.ts`, red fixture |
| W2 / func-Q2 (prose) | T, F | Minor | prose | Fixed — Derived inputs path updated |
| W3 / func-Q2 (design) | T, F | Minor | design | Fixed — `TERRAFORM_DIR` depth, `export *` shim, existence assertion |
| func-Q1 | F | Minor | design | Fixed — stub sentinels distinct and type-valid; self-test asserts the stub passes the validator |
| sec-Q1 | S | Minor | design | Fixed — I1.3 exact env-name set; `GITHUB_TOKEN` red case |
| sec-Q2 | S | Minor | design | Fixed — smoke-map URL users pinned to db-grants-manifest ROLEATTR (no super/bypassrls, login) |

## Recurring Issue Check
### Functionality expert
R1 ok · R2 ok · R3 Q2 · R16 ok · R18 ok · R29 ok · R32–R35 ok · R41 ok · R42 ok · R48 ok · R49 ok · R50 Q1 · others N/A
### Security expert
R2 ok · R3 ok · R14 Q2 · R16 ok · R18 ok · R29 ok · R32–R35 ok · R41 ok · R42 Q2 · R43 Q1 · R47 ok · R48 ok · R49 Q1 · R50 ok · R52 ok · RS3 ok · RS4 ok · others N/A
### Testing expert
R1 ok · R2 ok · R16 ok · R18 ok · R29 W2 · R32–R35 ok · R40 ok · R41 ok · R42 W1 · R45 ok · R47–R50 ok · RT1 ok · RT2 ok · RT5 ok · RT7 W1,W3 · RT9–RT11 ok · others N/A

---

# Round 5
Date: 2026-11-16

## Changes from Previous Round
Revision 5: C9 (meta-gate reaches .ts checks), exact publisher env-name set,
ROLEATTR pin of smoke-map users, type-valid sentinels, hcl-subset move details.

No Critical or Major findings.

| ID | Expert | Sev | Class | Disposition |
|----|--------|-----|-------|-------------|
| sec-R1 / X2 | S, T | Minor | design | Fixed — all three ROLEATTR rows required; absent row fails; red message names missing rows |
| sec-R2 | S | Minor | design | Fixed — smoke-map users pairwise distinct and ≠ app DATABASE_URL user; `passwd_app` red case |
| func-R1 / X1 | F, T | Minor | design | Fixed — `.ts` extension strip at both sites; allow fixture; `.ts` stale-debt fixture |
| X3 | T | Minor | design | Fixed — fixed-length unique sentinels, no-substring assertion |
| X4 | T | Minor | prose | Fixed — count dropped; `hcl-subset.test.ts` moves with the module |

## Recurring Issue Check
### Functionality expert
R2 ok · R3 R1 · R14 ok · R16 ok · R18 ok · R29 ok · R32–R35 ok · R41 ok · R42 ok · R48–R50 ok · others N/A
### Security expert
R2 ok · R3 ok · R14 R2 · R16 ok · R18 ok · R29 ok · R32–R35 ok · R41 ok · R42 R2 · R43 ok · R47 ok · R48 ok · R49 R1 · R50 ok · R52 ok · R55 R1 · RS3 ok · RS4 ok · others N/A
### Testing expert
R1 ok · R2 ok · R14 ok · R16 ok · R18 ok · R29 X4 · R32–R35 ok · R40 ok · R41 ok · R42 X2 · R45 ok · R47–R50 ok · R55 X3 · RT1 ok · RT2 ok · RT5 ok · RT7 X1,X2 · RT9 ok · RT10 X1 · RT11 ok · others N/A

---

# Round 6
Date: 2026-11-16

| ID | Expert | Sev | Class | Disposition |
|----|--------|-----|-------|-------------|
| Y1 / func-S1 | T, F | Major (T) / Minor (F) | design (test placement) | Fixed — test moves to `scripts/__tests__/hcl-subset.test.ts`; same test count before/after |
| sec-S1 | S | Minor | design | Fixed — anchored extraction of the app DB user; no-match fails; red case |

Recurring Issue Check (non-N/A): func R2,R3,R14,R16,R18,R29,R32–R35,R41,R42,R48,R49 ok, R50 S1 ·
sec R14,R42,R49 ok, R47/R55 S1 · test R14,R29,R42,R55,RT10,RT11 ok, R50/RT7 Y1.

## Saturation call (after round 6)
- Rounds completed: 6 (≥2).
- Open Critical/Major: none — every finding of rounds 4–6 is resolved in the plan
  (none carries an Anti-Deferral disposition).
- Character of rounds 4–6: every finding was against text the previous round had
  added (W1 against C9's predecessor gap, Q1/Q2/R1/R2/S1 against the role pin
  added in rounds 3–5, Y1 against the round-5 move note). No finding in rounds 5–6
  challenged a contract's purpose, control class or invariant set.
- Remaining Minors: none open.
- Decision: plan phase closed; Go/No-Go gate locked (C1–C9). The test-placement
  and extraction details settled in rounds 5–6 are re-verified by execution in
  Phase 2 (vitest test counts, red cases).
