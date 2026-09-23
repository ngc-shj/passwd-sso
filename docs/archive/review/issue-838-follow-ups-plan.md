# Plan: issue-838-follow-ups

Branch: `fix/issue-838-follow-ups` · Issue: `#838` (known limits carried over from PR `#830`)

## Project context

- Type: `mixed` — two CI gates (Node/ts-morph, bash+awk), one Claude Code pre-tool-use hook (bash), one offline operator CLI (tsx, Prisma on `MIGRATION_DATABASE_URL`).
- Test infrastructure: `unit + integration + E2E + CI/CD`. Gate and hook self-tests live in `scripts/__tests__/*.test.mjs` (vitest, spawn the real script against fixture trees). The operator CLI has unit tests in `scripts/__tests__/tenant-domain-*.test.ts` and real-DB tests under `npm run test:integration`.
- Verification environment constraints:
  - **E1** — no production database. The backfill (C4) is built and exercised against the dev database and integration fixtures only; its production run, and the three measurements it needs first, are operator work. Classification: `blocked-deferred` for the production path. Anti-Deferral: running operator tooling against production from this session is forbidden by the task itself and needs credentials this environment does not hold; the cost of NOT running it is bounded because the tool defaults to dry-run and reports before it writes.
  - **E2** — BSD grep / macOS bash 3.2 are not available locally (Linux host). Hook and grep-q gate behaviour on macOS is `verifiable-CI` only where CI has a macOS runner; otherwise `blocked-deferred` with the same justification PR `#830` recorded (the constructs used are POSIX ERE and bash-3.2 compatible, checked by reading, not by execution).
  - **E3** — integration tests cannot share the dev DB with the running workers: `docker compose stop audit-outbox-worker retention-gc-worker` before `npm run test:integration`.

## Objective

Close, or turn into refusals, the four known limits `#838` lists, without widening what any control claims beyond what it implements.

## Requirements

- R-1 Each control keeps or tightens its declared control class; nothing is re-described as a boundary.
- R-2 Every widened refusal ships with paired allow cells for the sanctioned shapes it must not refuse (RT10).
- R-3 Every new refusal is red-proved: removing the predicate turns its cell red (RT7). Mutations run on scratchpad copies only.
- R-4 Gate runtime is measured before and after, interleaved (R45/R53); no absolute figure is written into code comments.
- R-5 The backfill never writes without an explicit `--apply`, and decides "divergent" by the same rule the application adjudicator uses (R48).

## Technical approach and contracts

### C1 — `.claude/hooks/block-bare-decrypt.sh`: widen the printer refusal, separate "matcher did not run"

**Control class**: `best-effort tripwire` (unchanged). Adjudication authority: none at decision time — the hook reads the pre-execution command string; bash's parser is not consulted. Input axes covered are enumerated below; the residual stays in the header.

Signature: unchanged — stdin tool payload, exit 0 allow / exit 2 block, JSON error on stderr.

**Mechanism change — the predicates stop being regexes over the whole string** (F-R2-2, S2-F5). Round 2 reproduced a false negative that no window regex survives: `_CRED=$(… decrypt id); awk -F'|' '{print}' <<<"$_CRED"` prints the credential, and the quoted `|` inside `-F'|'` ends the match window before `$_CRED`. A single-quote parity counter for item 1 fails the same way on an apostrophe inside a double-quoted word. Both are the surface-form class (R47) this repo has already answered once, in `check-no-pipe-into-grep-q.sh`'s quote-tracking scanner.

So the decision moves into ONE scanner, written in the `python3` the hook already requires for reading `tool_input.command` (it fails closed today when python3 is absent, so this adds no dependency). The scanner walks the command once tracking THREE dimensions, not one (S3-F1):

- **quote state** — unquoted / single / double;
- **nesting depth** — an unquoted `$( … )`, a backtick span, or a `( … )` subshell is a nested region. An operator inside one is NOT a top-level split point: `echo $(true | false) "$_CRED"` is one simple command to bash, and a quote-only scanner splits it into `echo $(true` and `false) "$_CRED"`, so item 6 matches neither fragment and the credential prints. Each nested region is scanned RECURSIVELY as its own command — the way `check-no-pipe-into-grep-q.sh` recurses into a `bash -c` body — so a printer inside it is still judged, and its text still counts as part of the enclosing segment when asking whether `_CRED` is referenced there;
- **heredoc body** — after an unquoted `<<DELIM` / `<<-DELIM` token, the body is the following physical lines up to the first line consisting exactly of `DELIM` (leading tabs stripped on both the terminator and the body only for `<<-`); several heredocs on one line are consumed in redirection order (F-R3-3). The text is body, never operator-scannable, and it is the subject of item 5's rule rather than of item 6's segmentation.

It splits into simple commands at UNQUOTED, UNNESTED `| |& ; & && ||` and newline, records each segment's command word, its assignments, its redirections and its heredocs, and removes backslash-newline continuations only where bash does. A parse that completes but disagrees with bash's own segmentation raises nothing, so item 8 cannot catch it — which is why the dimensions above are part of the contract and each has an acceptance cell. Every rule below is then a question about ONE segment, asked of parsed structure rather than of text. `grep` disappears from the hook, and with it the three defects its use produced (SIGPIPE under `pipefail`, the 64 KB here-string temp file, BSD `grep -P`).

**What else moves with it** (F-R3-2): the hook's other three grep predicates migrate to the same scanner, because leaving them on `grep` would contradict the forbidden pattern below and would leave the decoy defence deciding on raw text. Decrypt DETECTION becomes "a segment whose command word (or its `npx tsx …` operand) is the CLI with `decrypt` as its first operand", at any nesting depth; the OCCURRENCE COUNT counts those segments, not regex matches, which is what makes `echo '<cli> decrypt x | pbcopy'; <cli> decrypt exposed` count as one rather than two; Shape 2's clipboard sinks become a segment test — the decrypt segment's stdout is piped to a segment whose command word and arguments match one documented sink form (the current `CLIP_RE` alternatives, unchanged in meaning, including the refusal of re-emitting flags such as `xclip -filter` / `xsel --output`). Behaviour is preserved, so the existing Shape-2 allow and deny cells stay green as written and are the proof of that.

Changes, all applied only inside Shape 1 (`_CRED=$( … decrypt … )`):

1. **Continuations** are removed by the scanner, in unquoted and double-quoted context only — bash keeps `\⏎` literal inside single quotes (S-F6) — which closes the `ec\⏎ho $_CRED` split without the parity bug (S2-F5).
2. **Variable dumpers refused regardless of whether `_CRED` is named**: `declare`/`typeset`/`local`/`export`/`readonly` with a `-p` option; bare `set`, bare `env`, bare `printenv`, bare `export` — each "bare" meaning no operand before end of simple command, a redirection, or a pipe; `compgen -v`. `env VAR=v cmd …` and `printenv OTHER` stay allowed: they exec or print something else (F-F4). `printenv _CRED` is refused under item 6.
3. **Tracing refused**: `set -x`, `set -o xtrace`, `bash -x`/`sh -x`, `BASH_XTRACEFD` — xtrace writes the expanded consuming command, credential included, to stderr.
4. **`_CRED` copied to another name refused**: an assignment whose right-hand side references `_CRED` (`x=$_CRED`, `x="${_CRED}"`, `read x <<<"$_CRED"`, `printf -v x … $_CRED`), and a nameref to it (`declare -n`/`typeset -n`/`local -n` naming `_CRED`, S-F4). A copy defeats every printer rule keyed on the name.
5. **Heredoc body referencing `_CRED` refused**: a `<<`/`<<-` heredoc (not `<<<`) whose body contains `_CRED` with an unquoted delimiter.
6. **Printers widened, decided per segment**: the command-word list becomes `echo printf cat tee printenv base64 xxd od hexdump openssl rev awk sed head tail dd paste tr iconv jq xargs column fold fmt nl pr less more`. A segment refuses when its command word is on the list AND `_CRED` is referenced anywhere in that segment — its words, its here-string, its heredoc. Because segmentation is quote-aware, `awk -F'|' … <<<"$_CRED"` refuses (F-R2-2) and `sed -i … cfg; curl -u "u:$_CRED" …` does not (S-F5).
7. **Brace expansion**: a `{…,…}` word containing `_CRED` is refused.
8. **"The scanner did not decide" is its own refusal**: any exception, timeout, or unparsable input in the scanner exits 2 with a message naming the scanner — never the same message as "no match", and never a status borrowed from another tool (R44). The `grep exit 3` collision disappears with `grep`.

Invariant (app-enforced, tripwire): every sanctioned `/use-credential` shape (SKILL.md Patterns A–E) stays allowed.

Residual (documented in the header, not closed): any printer not on the item-6 list, `eval`, aliases and functions, indirect expansion `${!name}`, `$(< file)` after writing the value to a file, a consuming command that itself echoes its arguments (`curl -v`, a verbose client), and anything whose spelling bash assembles at run time. The closure remains a decrypt surface that never returns plaintext (SC2).

Forbidden patterns:
- pattern: `grep` in the hook — reason: the decision is the scanner's; a text matcher is what produced the quoted-operator false negative and the SIGPIPE/here-string defects.
- pattern: a rule keyed on the whole command string rather than on one segment — reason: R47, the segment is the unit bash itself executes.

Acceptance:
- A-C1-0 The scanner is unit-tested at its own boundary, not only through the hook (T3-F2): it exposes the parsed structure (an importable function or a debug mode the test invokes), and cells assert the segments, command words, assignments, redirections and heredocs for — adjacent and nested quotes, a quote directly before and after an unquoted operator, a quoted heredoc delimiter, `\⏎` inside single quotes vs outside, `$( … )` nesting, and `|&`. A hand-rolled quote machine that is wrong in a way one rule's verdict happens to survive is what this catches.
- A-C1-1 Each of items 1–8 has a refusing cell and a red proof, one mutation per item — item 1 with its own cell (`ec\⏎ho $_CRED`) whose red proof disables only the continuation step and leaves item 6 intact (T-F1), and item 8's red proof removing the scanner's failure handling and showing the unparsable-input cell stops exiting 2 (T3-F1).
- A-C1-2 Patterns A–E and the existing allow cells stay green. Allow cells: `sed -i s/a/b/ cfg; curl -u "u:$_CRED" …`; `env DEBUG=1 cmd "$_CRED"`; a single-quoted argument containing `\⏎`; an apostrophe inside a double-quoted word earlier in the command followed by a genuine continuation split (S2-F5).
- A-C1-3 Deny cells for the reproduced leaks: `awk -F'|' '{print}' <<<"$_CRED"` (F-R2-2) and `echo $(true | false) "$_CRED"` (S3-F1, verified against real bash to be one command that prints the value), each with its red proof against the pre-change hook recorded once in the review artifact. A heredoc cell pairs with them: a `<<EOF` body referencing `_CRED` refuses, and the same body with a quoted delimiter (`<<'EOF'`, no expansion) is allowed.
- A-C1-4 The existing 200 KB cell (`block-bare-decrypt-hook.test.mjs`, "refuses a 200 KB bare decrypt when the here-string cannot be written") is rewritten: the here-string limit is gone with `grep`, so the cell asserts BLOCK for the same reason the unpadded bare decrypt is blocked — on the rule, not on a matcher failure — and the stderr names the bare-decrypt branch, not a scanner failure (T3-F4). A separate cell feeds the scanner an input it cannot parse and asserts the scanner-named refusal (T-F6, round 1).

### C2 — `scripts/checks/check-no-pipe-into-grep-q.sh`: fail-closed plumbing

**Control class**: `fail-closed verification gate` (unchanged). Adjudication authority for the hook member set: `.claude/settings.json` as parsed by `node` (JSON.parse), not a filename glob.

Changes:

1. **Repo root from the script's own location**: `REPO_ROOT` resolves from `${BASH_SOURCE[0]}`/`../..`, never from `git rev-parse` in the caller's cwd.
2. **awk failure is fatal**: per-file awk status is captured; non-zero → `ERROR: scanner failed on <file> (awk exit N)` and exit 1. No `|| true` on the scanner.
3. **Hook member set = wired ∪ present**: every `command` under `hooks.*[].hooks[]` in `<root>/.claude/settings.json` is classified. Exactly one simple command of the form `bash <path>` / `sh <path>` / `<path>.sh` with a literal relative path → a shell member, resolved against the root, which must exist as a regular file. Exactly one simple command whose interpreter is not a shell (`node <path>`, `python3 <path>`) → recorded as not-shell and not scanned, listed in the output (F-F5). Anything else — several commands (`&&`, `;`, `|`), a variable or `$CLAUDE_PROJECT_DIR` in the path, `bash -c` — is unclassifiable and fails the gate (S-F7). The union with `find .claude/hooks -name '*.sh'` keeps unwired scripts scanned. Settings JSON that does not parse fails the gate.
4. **The `.claude/hooks` existence rule applies to fixtures too**: the `NO_PIPE_GREP_Q_ROOT` exemption is removed. A tree with no `.claude/settings.json` has an empty wired set; a tree with neither the file nor the directory scans zero hooks and says so; a tree that wires one must contain it.
5. Output line reports wired, not-shell and scanned hook counts separately.

Member set (R42): `node -e 'const s=require("./.claude/settings.json");for(const e of Object.values(s.hooks??{}).flat())for(const h of e.hooks??[])console.log(h.command)'` → today `bash .claude/hooks/block-bare-decrypt.sh` (1 member). `find .claude/hooks -name '*.sh'` → the same file.

Forbidden patterns:
- pattern: `awk "$detect_awk" "$f" || true` — reason: swallows scanner failure (R44).
- pattern: `git rev-parse --show-toplevel` in this script — reason: root must not depend on the caller's cwd.

Acceptance:
- A-C2-1 Cells: awk made to fail (unreadable file) → exit 1 naming the file; settings wiring a missing hook → exit 1; unclassifiable commands — `bash a.sh && bash b.sh`, `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"` — → exit 1 each; malformed settings JSON → exit 1; run from an unrelated cwd → same result as from the root.
- A-C2-1b Allow cells: no `.claude/settings.json` and no `.claude/hooks/` → exit 0 reporting 0 wired / 0 scanned (the state every existing fixture is in; the shared fixture setup keeps passing unchanged — T-F1); a `node x.mjs` hook → exit 0, reported as not-shell; a tree wiring BOTH a shell hook and a `node` hook → exit 0 reporting wired 2 / scanned 1 / not-shell 1, so the three counts are shown to move independently (T3-F5).
- A-C2-2 Real-tree cell: the scanned hook set equals the wired set parsed from the real `.claude/settings.json`, and is non-empty.
- A-C2-3 Each of the above red-proved on a scratchpad copy of the gate.

### C3 — `scripts/checks/check-bypass-rls.mjs`: Program-backed reference cross-check

**Control class**: `fail-closed verification gate`. Adjudication authority: the TypeScript language service over a Program built from the scan root's `tsconfig.json` — reference resolution for the spellings it answers (item 3), and the type checker for the rest (items 5, 5c, 6). Where neither can decide — a specifier typed `string`, an unresolvable destructuring key, a helper-carrying value used outside a literal member read, an `any` receiver with a computed key — the case is REFUSED, not followed. One residual is UNVERIFIED and stays in the header: an ambient declaration (`.d.ts`, `declare module`) that types a value as the helper module; `.d.ts` files are inside the scan set, and Rule A is expected to cover it, but no probe has shown that (S-F escalation, "未検証"). Phase 2 either proves it with a fixture cell or records it as an open gap.

The existing syntactic analysis (call discovery, callback/model scan, allowlists) stays; C3 adds an adjudicator that bounds it:

1. **Program**: built from `<cwd>/tsconfig.json` over the same non-test `src/` files; missing tsconfig or a missing helper declaration → fail with a named error (fixtures supply both).
2. **Helper declarations**: `withBypassRls`, `withTenantRls` in `src/lib/tenant-rls.ts`; `withUserTenantRls`, `withTeamTenantRls` in `src/lib/tenant-context.ts`. Each must resolve to exactly the declared function (overloads included).
3. **Reference cross-check**: for every reference the language service returns for a helper declaration, outside its defining file, the syntactic pass must have ACCOUNTED for it — as a recognised direct call, a recognised import/load binding, or an already-reported indirect reference. An unaccounted reference is a violation: `helper reached by a form this gate does not analyse: <file>:<line>`. Measured (S-F2 probe, fixtures in the review artifact), this covers named and renamed re-exports, `export * as ns` namespaces, and LITERAL-keyed element access. It does NOT cover `export *` itself, a quoted or computed destructuring key, or a non-literal member name — the language service returns no reference for any of those, so they are closed by items 5b/5c below, not here. The plan said otherwise in round 1 (S-F3).
4. **Files reached only through the Program** are parsed by the syntactic pass even if `HELPER_MENTION_RE` does not match them.
5. **Module loads are judged by the specifier's TYPE, and there is no allowlist** (S-F1). Subjects: `import(…)`, a `require(…)` call, a call through a `NodeJS.Require` value, and a call whose callee type is `any` **with exactly one argument** — the `require`-shaped arity, which is what bounds this branch (F-R2-3). For each, the checker's type of the specifier argument must be a string-literal type or a union of them; each literal is resolved with `ts.resolveModuleName`, and a target inside the Program's source set that exports a helper (following `export *`) is a violation. A specifier typed `string` is REFUSED: the gate cannot prove where it points.
   Residual of the `any`-callee branch, stated because it is a widened refusal surface (F-R3-4): the subject is "one-argument call through an `any` callee", which also selects one-argument calls that have nothing to do with module loading. Such a call is refused when its argument's type is not a string literal, and the sanctioned remedy is to give the callee a type — not an allowlist. Measured today: the three `key-provider` sites, all passing.
   **Template specifiers** are the one shape with a resolution step of their own (S2-F3), because a template's type is `string` and refusing it outright would refuse `messages.ts`: take the static head (text before the first `${`). **The head must end in `/`** — a head ending mid-segment (`../../lib/tenant-${x}`) names a filename PREFIX, not a directory, and treating it as a directory lets a substitution complete to `tenant-rls.ts` while the containment check looks under a directory that does not exist (S3-F2). Such a head is REFUSED, as is a head with no `/` at all, and one that resolves inside the Program's source set. Otherwise resolve the head as a directory relative to the containing file and pass only when no Program source file lies under it, recursively. An alias head (`@/…`) resolves through `tsconfig` paths first and therefore lands inside the source set — refused. Boundary fixtures: empty head, `/` head, alias head, a head resolving into `src/`, a head ending mid-segment (`../../lib/tenant-${x}` — refused, S3-F2), and `messages.ts`'s own `../../messages/` (passes).
   Member set today, derived by AST + checker over non-test `src/` (the probe is committed to the review artifact): `src/i18n/messages.ts:93,111` (template, static head `../../messages/` resolves to a directory holding no Program source — passes), `src/lib/crypto/crypto-client.ts:150` (identifier typed `"hash-wasm"` — passes), `src/lib/key-provider/{aws-sm,azure-kv,gcp-sm}-provider.ts` (`req("@aws-sdk/…")` through an `any` callee, literal argument — passes), `src/lib/blob-store/runtime-module.ts:20` (`requireModule(moduleName)`, `moduleName: string` — REFUSED).
   The one refusal is closed by narrowing the wrapper rather than by an exception: `requireOptionalModule` takes `OptionalModuleName`, a literal union of the three names its callers pass — `@aws-sdk/client-s3` (`src/lib/blob-store/s3-blob-store.ts` and `src/lib/audit/anchor-destinations/s3-destination.ts`), `@google-cloud/storage` (`src/lib/blob-store/gcs-blob-store.ts`), `@azure/storage-blob` (`src/lib/blob-store/azure-blob-store.ts`). Cited by subject, not by line: Phase 2 re-derives the set rather than trusting a frozen number (F-R3-5). (`@aws-sdk/client-secrets-manager` is loaded by `src/lib/key-provider/aws-sm-provider.ts` through its own `req`, not this wrapper — F-R2-4.) The four production callers pass `const` literals and need no change; `src/lib/blob-store/runtime-module.test.ts:14,33` does change — it calls the real export with `"example-module"` / `"missing-module"` and would fail `tsc --noEmit`, which `pre-pr.sh` and CI both run (F-R2-1, T-F4). It moves to a union member, keeping both assertions. TypeScript then enforces the restriction on every future caller — which the file-keyed allowlist could not (the wrapper is exported: laundering through it was the real hole).
5b. **`export *` of a helper-exporting module is a violation** wherever it appears in the scan set outside the defining files: the re-export produces no reference, so the barrel is refused instead of followed. (`export { x } from` and `export * as ns from` DO produce references and are handled by item 3.)
5c. **A destructuring key that is not an identifier is resolved or refused**: for a `BindingElement` whose `propertyName` is a string literal or a computed key, the property symbol is resolved from the pattern's type and alias-resolved; resolving to a helper binds the local name as a helper binding (so the call is analysed), and failing to resolve is a violation (S-F3).
6. **Refusal by receiver type, not by member name** (S-F2):
   - **Rule A** — an expression whose type carries a helper may appear ONLY as the receiver of a literal-named property access or literal-keyed element access. Anywhere else — a non-literal element access, an argument, a spread, a `for…in`, an object-rest, `Object.values`/`entries`, `Reflect.get`, an assignment to `globalThis` — it is a violation. Measured on the real tree: 0 hits.
     *Carries a helper* is decided over DECLARATIONS, not symbol identity (S2-F2): for each property of the expression's apparent type, alias-resolve the symbol and test whether its declaration set intersects the four helper declarations. A union is covered by this because the synthetic property symbol a union yields carries every constituent's declaration; an intersection likewise. A type that holds the module inside a generic (`Promise<typeof import("@/lib/tenant-rls")>` before `await`) does NOT carry a helper as a property and is NOT Rule A's subject — the awaited value is, and that is where the rule fires. Both shapes get a fixture, deny and allow (A-C3-1/2b).
   - **Rule B** — an element access on a receiver typed `any`/`unknown` whose KEY type is not a string-literal union is a violation. Measured on the real tree: 2 hits, both with literal-union keys, so both pass.
   - A helper-named member that resolves to a different declaration is provably not the helper and passes.
7. The header's round-13 paragraph — "Only an `import()` or `require()` call whose specifier is a literal naming the module is recognised" — is rewritten too: item 5 decides on the specifier's TYPE, which is strictly wider than a syntactic literal (F-R2-5). The "known not covered" list drops only the entries this contract closes (re-export, barrel, non-literal load, quoted/computed key, helper-named member of an unknown object). Everything else stays verbatim: scan root `src/` only (SC3); the whole client-propagation class — imported callee, `this`, spread before the client, unprovable receiver (SC4); BYPASS_PURPOSE file scope; `INDIRECT_CALLBACK_ALLOWLIST` keyed by file; a client returned by a call (F-F2).

Performance (R45/R53): current gate ≈1.7 s wall (`time node scripts/checks/check-bypass-rls.mjs`). Program probes disagree and both figures are recorded rather than averaged — ≈3.4 s for a Program over 1024 added files plus `findReferences` ×4 (orchestrator probe), ≈10 s for Program build with dependency resolution alone, ≈15.5 s when a type is queried for every identifier (Rule A, S-F5 probe), ≈3.1 s for element accesses only (Rule B). The divergence is what Phase 2 must settle: it re-measures each rule's scan separately (item 5's `any`-callee branch included), interleaved with the pre-change build, and records the commands. Budget: the gate stays under 30 s wall on the measuring machine, which is the `static-checks` job's headroom.

**How a rule may be made cheaper, and how it may not** (S2-F1): only by narrowing the SYNTACTIC POSITIONS a type is queried for — Rule A needs a type only where its own violation list can fire (receiver of a member access, argument, spread, rest, `for…in` subject, assignment source/target), not for every identifier. Every file stays in the scan. Narrowing by import graph is forbidden: a helper-carrying value reaches a file through an inferred generic or a parameter with no import edge to follow, which is SC4's class — the one Rule A exists to close.

The self-test suite is 142 tests / 28.7 s today (`npx vitest run scripts/__tests__/check-bypass-rls.test.mjs`, T-F2), and CI's `app-ci` coverage step already runs ~13–14 min against a 20 min cap (`.github/workflows/ci.yml`). The fixture-tree cost is NOT the real-tree cost and has not been measured: fixtures live under `mkdtemp` with no `node_modules` above them, so each Program build walks a failing resolution for `@prisma/client` (T-F2). Phase 2 measures one fixture spawn first and, if resolution dominates, gives the harness a minimal ambient stub for the external types rather than accepting the cost. Budget: the suite stays under 2× its measured pre-change time. **There is no flag that disables the Program pass** (S2-F4): a predicate that can be switched off by ambient state is not a fail-closed gate, and the cited `NO_PIPE_GREP_Q_ROOT` precedent relocates a scan root without removing a check. If the budget cannot be met, the lever is the harness — one Program reused across cells in a worker, or fewer spawns per rule — never the rule.

Fixture declarations (T-F4, F-F3): the harness does not hand-write stub helpers. It copies the real `src/lib/tenant-rls.ts` and `src/lib/tenant-context.ts` into each fixture tree (their unresolved imports are irrelevant — the gate reads references, not diagnostics) plus a minimal `tsconfig.json` with the `@/*` path. A test that writes its own `src/lib/tenant-context.ts` (today `TENANT_CONTEXT_ALLOWED`) appends the real file's helper declarations to its body through one harness helper, so no fixture carries a divergent copy.

Forbidden patterns:
- pattern: `skipFileDependencyResolution: true` in the Program construction for C3 — reason: re-exports are exactly what dependency resolution follows.
- pattern: a helper-name string comparison used as the verdict for a reference the checker resolved — reason: R47, the checker adjudicates.
- pattern: `NON_LITERAL_LOAD_ALLOWLIST` — reason: item 5 refuses the class by type; an allowlist keyed by file or text cannot see laundering through an exported wrapper (S-F1).

Acceptance:
- A-C3-1 One persisted fixture cell per spelling named in `#838`, each asserting the current gate reports it, and each naming WHICH item decides it: named re-export, renamed re-export, `export * as ns`, literal-keyed element access (item 3); `export *` barrel (5b); quoted destructuring key, computed key (5c); `string`-typed specifier, `requireModule(x)` through a typed require, an `any` callee with a non-literal argument (item 5); `ns[n](…)` on a helper-carrying namespace, the same namespace spread / passed as an argument / read through `Reflect.get` / assigned to `globalThis` (Rule A); an `any`-typed receiver with a non-literal key (Rule B). The `export *` barrel cell also proves item 4: the barrel file's own text contains no helper name, so `HELPER_MENTION_RE` does not select it and only the Program does — the cell asserts the gate parsed that file (T3-F3). Separately, once, for the review artifact: the same fixtures run against the pre-change gate pass, recorded with command and output (T-F5).
- A-C3-2 Allow cells: a local unrelated function named `withBypassRls` in a file that never imports the module; a re-export of a NON-helper from `tenant-context.ts` (today's `realignOwningTenantColumn` shape); a resolvable receiver whose helper-named member is a different declaration (`const x = { withBypassRls: () => 0 }; x.withBypassRls()`, T-F3).
- A-C3-2b Allow cells from the real tree's own shapes, each pinned as a fixture: a template specifier whose static head resolves outside the Program source set (`messages.ts`); an identifier specifier with a literal type (`crypto-client.ts`); an `any` callee with a literal argument (`key-provider`); an `any`-typed receiver with a literal-union key (`auth-gate.ts` shape).
- A-C3-2c Allow cells for the refusals 5b and 5c bring (T-F6): `export *` of a module that exports no helper; a quoted and a computed destructuring key that resolve to a non-helper property.
- A-C3-3 Real tree passes with no allowlist; `npx tsc --noEmit` passes after the narrowing WITH the `runtime-module.test.ts` edit and no production call-site change; the printed parse count and runtime are recorded.
- A-C3-4 Existing self-tests pass with the harness above; a fixture missing a helper declaration or `tsconfig.json` fails with the named error (one cell each).
- A-C3-5 Suite runtime recorded pre/post, interleaved, within the budget above.

### C4 — `User.tenantId` backfill tooling (`scripts/tenant-domain.ts`)

**Control class** for the write: operator tool guarded by `fail-closed` preconditions (dry-run default, per-user re-check inside the write transaction). Adjudication authority for "divergent": the application's owning-tenant rule — oldest ACTIVE membership, else the column.

Signatures:

```ts
// src/lib/tenant/owning-tenant-rule.ts (new, no Prisma singleton import)
export function owningTenantOf(column: string, activeMembershipsOldestFirst: readonly { tenantId: string }[]): string;

// scripts/tenant-domain.ts
export async function cmdMeasure(): Promise<CmdResult>;          // read-only: the three design-note counts
export async function cmdBackfillOwningColumn(args: {
  by: string; apply?: boolean; yes?: boolean; limit?: number; confirm?: ConfirmFn;
}): Promise<CmdResult>;
```

1. `owningTenantOf` moves out of `tenant-context.ts` into the new module; `tenant-context.ts` imports it (one rule, two callers — R48). It is module-private today (`grep -rn owningTenantOf src scripts` → only `src/lib/tenant-context.ts`), so no importer's path changes.
2. `measure` runs the three queries from `audit-tenant-adjudicator-design.md` verbatim inside `withBypassRls(…, SYSTEM_MAINTENANCE)` and prints the counts. No writes.
3. `backfill-owning-column` validates `--by` with the existing `validateActorLabel` before building a client, exactly as `cmdAdd`/`cmdRemove`/`cmdRealign` do (S-F3). It selects users with ≥1 active membership whose `owningTenantOf(column, active)` ≠ column, read inside `withBypassRls(…, SYSTEM_MAINTENANCE)` like `measure` and like the write path — a divergent user is by definition filed under a tenant other than the one deciding, so an RLS-bound read would not see them (F-R2-6) — in keyset pages ordered by `users.id` (unique) with a fixed page size, so enumeration is bounded per query rather than loading every user (S-F8); `--limit` (default and maximum set as named constants) caps the candidates one run lists or applies. Without `--apply` it prints the candidate count, per-user `{userId, from, to, activeMembershipCount}` and exits 0 with no writes. With `--apply` (and confirmation or `--yes`), each user is processed in its own bypass transaction that RE-READS the column and active memberships, recomputes the target, skips if no longer divergent, and moves the column through `realignToMembershipInTxWith` with `REALIGNMENT_SOURCE.OPERATOR`, `SYSTEM_ACTOR_ID`, and `--by`. Output prints ids and tenant ids only — no email or other row content.
4. Users with more than one active membership are included (the adjudicator decides them) and flagged `multiActive` in the output; the design note's query (2) count is printed first so the operator sees it.

Consumer-flow walkthrough:
- Consumer `emitRealignment` (path: `src/lib/tenant/tenant-realignment-core.ts`) reads `{ userId, memberId, tenantId, cause }` and uses `tenantId`/`previousTenantId` to file one `USER_TENANT_REALIGNED` row under each tenant. `memberId` is the target tenant's active membership id, which the per-user transaction reads — satisfiable.
- Consumer: the operator reading dry-run output reads `{ userId, from, to, activeMembershipCount }` to decide whether to apply.

Forbidden patterns:
- pattern: `tx.user.update(` / `updateMany(` in `cmdBackfillOwningColumn` — reason: the move goes through `realignOwningTenantColumn` so it is recorded.
- pattern: `import .*@/lib/prisma"` reachable from `scripts/tenant-domain.ts` — reason: the CLI runs without `DATABASE_URL` (existing import-graph test).

Acceptance:
- A-C4-1 Unit: `owningTenantOf` cases (no active → column; one; several → oldest).
- A-C4-2 Integration (real DB): a divergent user is listed by dry-run with zero writes (row and audit outbox unchanged); `--apply --yes` moves exactly that user and writes both audit rows; a user whose membership is deactivated between listing and apply is skipped; a non-divergent user is never touched.
- A-C4-2b Integration: three divergent users, `--apply --yes --limit 1` → exactly one moved; a user with two active memberships appears in dry-run output flagged `multiActive` with `to` = the older membership's tenant (T-F7).
- A-C4-2d Isolation (T-F5): every C4 assertion over `measure`'s counts and over the candidate list is a DELTA around the fixture (count before / count after), never an absolute or "non-zero" figure — those tables are system-wide and hold steady-state rows. A divergent fixture's cleanup deletes by USER ID, and by both the `from` and the `to` tenant, because `deleteTestData(tenantId)` scopes by the column the test just moved; a cell asserts the tables are back to their pre-fixture counts.
- A-C4-2c Unit: an invalid `--by` (reserved `signin`, a bidi control) is rejected before any client is built, for `backfill-owning-column` (S-F3).
- A-C4-3 `measure` returns the three counts on a seeded fixture that makes each non-zero.
- A-C4-4 README "IdP domain changed / tenant locked out" section and `CLAUDE.md`'s `tenant-domain` line list the two new verbs.

## Testing strategy

- Hook and both gates: extend the existing `scripts/__tests__/*.test.mjs` suites; red proofs on scratchpad copies with the cell list and outcome recorded in the review artifact.
- C4: unit tests in `scripts/__tests__/tenant-domain-*.test.ts` style; real-DB cells under `src/__tests__/db-integration/` (workers stopped, E3).
- Full `npx vitest run`, `npx next build`, `scripts/pre-pr.sh` before PR.

## Considerations & constraints

Production code this touches outside the gates: `src/lib/blob-store/runtime-module.ts`'s `requireOptionalModule` parameter type narrows from `string` to a literal union (C3 item 5). It is the enforcement's prerequisite, not a behaviour change — the runtime is unchanged and no call site moves — and it is what makes the refusal hold for future callers.

Scope contract:
- **SC1** — Running the measurements or the backfill against production. Owner: operator, after merge (E1).
- **SC2** — A decrypt surface that never returns plaintext (the real closure for C1). Owner: future issue; stays listed in the hook header.
- **SC3** — Widening `check-bypass-rls`'s scan root beyond `src/` (`scripts/tenant-domain.ts`, `scripts/manual-tests`). Owner: follow-up issue; not part of `#838`.
- **SC4** — Client-propagation into imported callees in `check-bypass-rls` (the gate's other fail-open class). Owner: follow-up issue; the Program built here is the prerequisite, the analysis is not in `#838`.
- **SC5** — The partial unique index on active memberships (design note Q11). Owner: after production measurement (2) is known.

## User operation scenarios

- An operator on a deployment runs `tenant-domain measure`, sees query (1) = 12, runs `backfill-owning-column` (dry-run), reviews twelve rows, then `--apply --by ops-alice`; each tenant's admin sees `USER_TENANT_REALIGNED` rows with source `operator`.
- A developer running `/use-credential` Pattern C with `sshpass -p "$_CRED" ssh host` is allowed; the same command with `set -x` prepended is refused with a message naming tracing.
- A contributor adds `export * from "@/lib/tenant-rls"` to a barrel and imports `withBypassRls` from it in a route; `check-bypass-rls` fails naming the unaccounted reference.

## Go/No-Go Gate

| ID  | Subject                                                        | Status  |
|-----|----------------------------------------------------------------|---------|
| C1  | block-bare-decrypt: quote/nesting-aware scanner, widened refusals | locked |
| C2  | no-pipe-into-grep-q: root, awk failure, wired hook member set   | locked |
| C3  | check-bypass-rls: Program cross-check + checker-type refusals   | locked |
| C4  | owning-column measurement + dry-run backfill                    | locked |
